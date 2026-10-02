/**
 * maki's passphrase wallets, end to end: the real app, offscreen, linked to the fake maki running
 * maki's Tron app, with the recovery phrase's own wallet open and with a passphrase wallet
 * (`--passphrase`). Run after run over the same folder of what the app keeps, as a person's would
 * be: the account added under the passphrase wallet is that wallet's (its address, worked out here
 * from BIP39 and BIP32, isn't the phrase's own), and each wallet's account stays its own, neither
 * shown nor kept as the other's. And in one run, as maki opens the passphrase wallet and goes back
 * (here, one fake maki taking another's place): the page turns to the wallet maki has.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e/passphrase.test.ts
 *
 * It needs a display to render into (Wayland or X), a fake maki that knows passphrase wallets,
 * and builds the app first.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { createBase58check } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { spawn, type ChildProcess } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import { TRX_ME, tronStandIn } from '../shared/coin-stand-ins'
import { serve } from '../shared/stand-ins'
import {
  APP_FIXTURES,
  FAKE,
  FAKE_BUILT,
  FAKE_NAME,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { build, drive, E2E } from './drive'

const TEST_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSPHRASE = 'maki e2e'

/** BIP39's seed from the test phrase and a passphrase, worked out here. */
const seedOf = (passphrase: string): Uint8Array =>
  pbkdf2Sync(TEST_PHRASE, `mnemonic${passphrase}`.normalize('NFKD'), 2048, 64, 'sha512')

/** A wallet's fingerprint, as wallets write it: its BIP32 master key's. */
const fingerprintOf = (passphrase: string): string =>
  HDKey.fromMasterSeed(seedOf(passphrase)).fingerprint.toString(16).padStart(8, '0')

/**
 * A wallet's first Tron account (TronLink's and Ledger's, m/44'/195'/0'/0/0): 0x41 and the last 20
 * bytes of the Keccak-256 of its public key, in base58check. Worked out here, not by maki desktop.
 */
const tronOf = (passphrase: string): string => {
  const key = HDKey.fromMasterSeed(seedOf(passphrase)).derive("m/44'/195'/0'/0/0").publicKey!
  const full = secp256k1.Point.fromBytes(key).toBytes(false)
  return createBase58check(sha256).encode(
    Uint8Array.of(0x41, ...keccak_256(full.slice(1)).slice(12))
  )
}

/** A fake maki listening on `port`, as startFake starts one on any. */
function fakeOn(port: number, args: string[]): Promise<ChildProcess> {
  const proc = spawn(FAKE, [`127.0.0.1:${port}`, '--name', FAKE_NAME, ...args])
  return new Promise((ok, fail) => {
    proc.stdout!.on('data', (d: Buffer) => /listening on/.test(d.toString()) && ok(proc))
    proc.once('exit', () => fail(new Error('fake maki exited')))
  })
}

/** Stops a fake maki, and waits until it's gone (and its port free). */
function stop(proc: ChildProcess): Promise<void> {
  return new Promise((ok) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return ok()
    proc.once('exit', () => ok())
    proc.kill()
  })
}

/** Waits until `ready` says so, two minutes at most. */
async function until(what: string, ready: () => boolean): Promise<void> {
  const end = Date.now() + 120_000
  while (!ready()) {
    if (Date.now() > end) throw new Error(`never: ${what}`)
    await new Promise((ok) => setTimeout(ok, 250))
  }
}

describe.skipIf(!E2E || !FAKE_BUILT)('passphrase wallets, end to end', () => {
  const FINGERPRINT = fingerprintOf(PASSPHRASE)
  const TRX_PASSPHRASE = tronOf(PASSPHRASE)
  const TRON = ['--app', join(APP_FIXTURES, 'tron.maki')]
  const fakes: ChildProcess[] = []
  let phrase: { port: number; proc: ChildProcess }
  let passphrase: { port: number; proc: ChildProcess }
  let server: { url: string; close: () => void }
  let home = ''

  beforeAll(async () => {
    build()
    phrase = await startFake(TRON)
    passphrase = await startFake([...TRON, '--passphrase', PASSPHRASE])
    fakes.push(phrase.proc, passphrase.proc)
    // the fake must say which wallet it has: one built before passphrase wallets doesn't, and
    // would show the phrase's own wallet as if it were the passphrase's
    const t = await TcpTransport.open(passphrase.port)
    const said = await new MakiClient(t).walletStatus()
    await t.close()
    if (said?.kind !== 'passphrase')
      throw new Error(
        `this fake maki doesn't open passphrase wallets (it said ${JSON.stringify(said)}): build it from the firmware's current source`
      )
    // TronGrid, for the phrase's own account as ever, and the passphrase wallet's as one that's new
    const grid = tronStandIn()
    server = await serve((method, path, body) =>
      path.startsWith(`/v1/accounts/${TRX_PASSPHRASE}`)
        ? Promise.resolve([200, JSON.stringify({ data: [], success: true })])
        : grid.answer(method, path, body)
    )
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(async () => {
    await Promise.all(fakes.map(stop))
    server?.close()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  /**
   * The app over `data` (what it keeps, in `home`), linked to the fake maki on `port`, then
   * `steps`. It opens on the page it was on last, so it links from the Overview itself (the
   * harness's link is made from there, the first time): as each time maki is linked here.
   */
  const LINK = ['--click', 'Overview', '--click', 'Use fake maki', '--gone', 'looking for maki']
  const run = (data: string, port: number, steps: string[]): Promise<string> =>
    drive(home, port, [...LINK, ...steps], {
      MAKI_COIN_SERVER: server.url,
      MAKI_OFFSCREEN_DATA: join(home, data)
    })

  /** The Tron accounts the app kept in `data`'s `file`, by address; none if it has no such file. */
  const kept = (data: string, file: string): string[] => {
    try {
      const all = JSON.parse(readFileSync(join(home, data, file), 'utf8')) as {
        tron?: { address: string }[]
      }
      return all.tron?.map((a) => a.address) ?? []
    } catch {
      return []
    }
  }

  it('works addresses and fingerprints out as wallets do', () => {
    // the test phrase's own, as TronLink has it and as BIP32's test vectors' fingerprint is
    expect(tronOf('')).toBe(TRX_ME)
    expect(fingerprintOf('')).toBe('73c5da0a')
    expect(TRX_PASSPHRASE).not.toBe(TRX_ME)
  })

  it('keeps each wallet’s Tron account its own: added under each, shown under each, never the other’s', async () => {
    // the phrase's own wallet open: its account, added, kept where it always was
    const first = await run('apart', phrase.port, [
      ...['--click', 'Wallets', '--click', 'Tron › Add from maki', '--until', 'as of'],
      ...['--click', 'Tron › Receive', '--until', TRX_ME]
    ])
    expect(first).toContain(TRX_ME)
    expect(first).not.toContain('passphrase wallet')
    expect(kept('apart', 'accounts.json')).toEqual([TRX_ME])

    // a passphrase wallet open: the page says so, and has no Tron account until one is added from
    // maki, the passphrase wallet's
    const second = await run('apart', passphrase.port, [
      ...['--click', 'Wallets', '--until', `maki has passphrase wallet ${FINGERPRINT} open`],
      ...['--until', 'Your Tron account, here', '--click', 'Tron › Add from maki'],
      ...['--until', 'as of', '--click', 'Tron › Receive', '--until', TRX_PASSPHRASE]
    ])
    expect(second).toContain(
      `maki has passphrase wallet ${FINGERPRINT} open: these are its accounts. The phrase’s own wallet’s are kept for when it’s open again.`
    )
    expect(second).toContain(TRX_PASSPHRASE)
    expect(second).not.toContain(TRX_ME)
    expect(kept('apart', `accounts.wallet-${FINGERPRINT}.json`)).toEqual([TRX_PASSPHRASE])
    expect(kept('apart', 'accounts.json')).toEqual([TRX_ME])

    // the phrase's own wallet again: its account as it was, and nothing of the passphrase wallet's
    const third = await run('apart', phrase.port, [
      ...['--click', 'Wallets', '--until', 'as of'],
      ...['--click', 'Tron › Receive', '--until', TRX_ME]
    ])
    expect(third).not.toContain(TRX_PASSPHRASE)
    expect(third).not.toContain('passphrase wallet')
    expect(kept('apart', 'accounts.json')).toEqual([TRX_ME])
    expect(
      readdirSync(join(home, 'apart'))
        .filter((f) => f.startsWith('accounts.'))
        .sort()
    ).toEqual(['accounts.json', `accounts.wallet-${FINGERPRINT}.json`])
  }, 420_000)

  it('turns the page to the wallet maki has as it opens a passphrase wallet and goes back, while it runs', async () => {
    // a maki of this test's own, which "opens a passphrase wallet" by a fake maki with one taking
    // its place on the same port, and "goes back" the same way
    const own = await startFake(TRON)
    fakes.push(own.proc)
    let now = own.proc
    const swap = async (args: string[]): Promise<void> => {
      await stop(now)
      now = await fakeOn(own.port, [...TRON, ...args])
      fakes.push(now)
    }
    const driving = run('live', own.port, [
      // the phrase's own wallet: its account added
      ...['--click', 'Wallets', '--click', 'Tron › Add from maki', '--until', 'as of'],
      // a passphrase wallet: the page turns to it, with no Tron account until one is added
      ...['--until', 'looking for maki', ...LINK, '--click', 'Wallets'],
      ...['--until', `maki has passphrase wallet ${FINGERPRINT} open`],
      ...['--until', 'Your Tron account, here', '--click', 'Tron › Add from maki'],
      ...['--until', 'as of'],
      // the phrase's own again: the page turns back, to its account (while maki is away, it stays
      // with the passphrase wallet, as the last maki had open)
      ...['--until', 'looking for maki', '--until', `These are passphrase wallet ${FINGERPRINT}’s`],
      ...[...LINK, '--click', 'Wallets', '--gone', 'passphrase wallet'],
      ...['--click', 'Tron › Receive', '--until', TRX_ME]
    ])
    const switching = (async () => {
      await until('the phrase’s own account kept', () =>
        kept('live', 'accounts.json').includes(TRX_ME)
      )
      await swap(['--passphrase', PASSPHRASE])
      await until('the passphrase wallet’s account kept', () =>
        kept('live', `accounts.wallet-${FINGERPRINT}.json`).includes(TRX_PASSPHRASE)
      )
      await swap([])
    })()
    const [said] = await Promise.all([driving, switching])
    expect(said).toContain(TRX_ME)
    expect(said).not.toContain(TRX_PASSPHRASE)
    expect(said).not.toContain('passphrase wallet')
    expect(kept('live', 'accounts.json')).toEqual([TRX_ME])
    expect(kept('live', `accounts.wallet-${FINGERPRINT}.json`)).toEqual([TRX_PASSPHRASE])
  }, 420_000)
})
