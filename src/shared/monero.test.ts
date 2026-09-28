/**
 * maki's Monero app, through the fake maki (maki's own app host and keys, from the BIP39 test
 * phrase): the addresses Ledger's Monero app and monero-python make for that phrase, compared on
 * maki first.
 */
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'
import { MoneroApp, MoneroNetwork } from './wallet-apps'

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)('the Monero app', () => {
  const fakes: ChildProcess[] = []
  const monero = async (args: string[] = []): Promise<MoneroApp> => {
    const fake = await startFake(args)
    fakes.push(fake.proc)
    const c = new MakiClient(await TcpTransport.open(fake.port))
    return new MoneroApp((app, message, timeoutMs) => c.appMessage(app, message, timeoutMs))
  }
  afterAll(() => fakes.forEach((p) => p.kill()))

  it('shows the test phrase’s addresses, as Ledger and every Monero wallet make them', async () => {
    const m = await monero(['--app', join(APP_FIXTURES, 'monero.maki')])
    expect(await m.address(MoneroNetwork.MONERO)).toEqual({
      approval: 'approved',
      address:
        '49vDbkSo7eve3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVF2N4Zn'
    })
    // Ledger's own test has this one
    expect((await m.address(MoneroNetwork.STAGENET)).address).toBe(
      '5A8FgbMkmG2e3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVHCRUaE'
    )
    expect((await m.address(MoneroNetwork.MONERO, 0, 1)).address).toBe(
      '8AB7PQPtducdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QZxJwPZ'
    )
  })

  it('says when the owner finds it doesn’t match, and when maki hasn’t the app', async () => {
    const m = await monero(['--app', join(APP_FIXTURES, 'monero.maki'), '--deny'])
    expect(await m.address(MoneroNetwork.MONERO)).toEqual({
      approval: 'denied',
      address:
        '49vDbkSo7eve3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVF2N4Zn'
    })
    expect((await (await monero()).address(MoneroNetwork.MONERO)).approval).toBe('no match')
  })
})
