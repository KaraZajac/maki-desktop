/**
 * The wallet against the fake maki, which signs with the firmware's own code (maki-btc) from the
 * BIP39 test phrase: the account, an address, and the fixture PSBT that the emulated firmware
 * also signs (libs/maki-btc/tests/fixtures in the firmware repo).
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { BtcAccount, Network } from './protocol'
import { readPsbt, toBase64 } from './psbt'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'

const FIXTURES = resolve(__dirname, '../../../xous-core/libs/maki-btc/tests/fixtures')
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)))
const HAVE_FIXTURES = existsSync(resolve(FIXTURES, 'abandon-unsigned.psbt'))

describe('reading PSBTs', () => {
  const bytes = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff, 0x01, 0x00])
  it('takes binary, base64 and hex, with or without whitespace', () => {
    expect(readPsbt(bytes)).toEqual(bytes)
    expect(readPsbt(toBase64(bytes))).toEqual(bytes)
    expect(readPsbt(new TextEncoder().encode(`${toBase64(bytes)}\n`))).toEqual(bytes)
    expect(readPsbt('70736274ff0100')).toEqual(bytes)
    expect(readPsbt(' 7073 6274ff\n0100 ')).toEqual(bytes)
  })
  it('turns away what isn’t one', () => {
    expect(readPsbt('hello')).toBeNull()
    // the magic alone, with nothing after it
    expect(readPsbt('cHNidP8=')).toBeNull()
    expect(readPsbt(Uint8Array.from([1, 2, 3]))).toBeNull()
    expect(readPsbt('')).toBeNull()
  })
})

describe.skipIf(!FAKE_BUILT || !HAVE_FIXTURES)('the wallet', () => {
  const fakes: ChildProcess[] = []
  const client = async (args: string[] = []): Promise<MakiClient> => {
    const fake = await startFake(args)
    fakes.push(fake.proc)
    return new MakiClient(await TcpTransport.open(fake.port))
  }
  afterAll(() => fakes.forEach((p) => p.kill()))

  it('shares the account once the owner agrees', async () => {
    const maki = await client()
    const a = await maki.btcAccount(Network.BITCOIN)
    expect(a.approval).toBe('approved')
    // BIP84's test vector for the test phrase
    expect(a.zpub).toBe(
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
    )
    expect(a.descriptor).toMatch(
      /^wpkh\(\[73c5da0a\/84h\/0h\/0h\]xpub[1-9A-HJ-NP-Za-km-z]{107}\/<0;1>\/\*\)#[a-z0-9]{8}$/
    )
    const t = await maki.btcAccount(Network.TESTNET)
    expect(t.zpub.startsWith('vpub')).toBe(true)
    expect(t.descriptor).toMatch(/^wpkh\(\[73c5da0a\/84h\/1h\/0h\]tpub/)
  })

  it('gives nothing away when the owner says no', async () => {
    const maki = await client(['--deny'])
    expect(await maki.btcAccount(Network.BITCOIN)).toEqual({
      approval: 'denied',
      zpub: '',
      descriptor: ''
    })
    // an address that doesn't match still says which one maki showed
    expect(await maki.btcAddress(Network.BITCOIN, false, 0)).toEqual({
      approval: 'denied',
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
    })
    const r = await maki.btcSign(Network.BITCOIN, fixture('abandon-unsigned.psbt'))
    expect(r).toEqual({ approval: 'denied', reason: '', signed: null })
  })

  it('shows addresses to compare', async () => {
    const maki = await client()
    expect(await maki.btcAddress(Network.BITCOIN, false, 1)).toEqual({
      approval: 'approved',
      address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'
    })
    expect((await maki.btcAddress(Network.BITCOIN, true, 0)).address).toBe(
      'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'
    )
  })

  it('signs a PSBT exactly as the firmware does', async () => {
    const maki = await client()
    const r = await maki.btcSign(Network.BITCOIN, fixture('abandon-unsigned.psbt'))
    expect(r.approval).toBe('approved')
    expect(r.signed).toEqual(fixture('abandon-signed.psbt'))
  })

  it('has a taproot account too, and signs its coins as the firmware does', async () => {
    const maki = await client()
    const a = await maki.btcAccount(Network.BITCOIN, BtcAccount.TAPROOT)
    // BIP86's test vectors for the test phrase
    expect(a.zpub).toBe(
      'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ'
    )
    expect(a.descriptor).toMatch(
      /^tr\(\[73c5da0a\/86h\/0h\/0h\]xpub6BgBgses.*\/<0;1>\/\*\)#[a-z0-9]{8}$/
    )
    expect(
      (await maki.btcAccount(Network.TESTNET, BtcAccount.TAPROOT)).zpub.startsWith('tpub')
    ).toBe(true)
    expect(await maki.btcAddress(Network.BITCOIN, false, 0, BtcAccount.TAPROOT)).toEqual({
      approval: 'approved',
      address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
    })
    expect((await maki.btcAddress(Network.BITCOIN, true, 0, BtcAccount.TAPROOT)).address).toBe(
      'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7'
    )
    // taproot and native SegWit coins alike, from one PSBT request
    const r = await maki.btcSign(Network.BITCOIN, fixture('abandon-taproot-unsigned.psbt'))
    expect(r.approval).toBe('approved')
    expect(r.signed).toEqual(fixture('abandon-taproot-signed.psbt'))
  })

  it('takes a PSBT bigger than one piece', async () => {
    // a proprietary global field (0xfc) of 10 KB rides along untouched
    const unsigned = fixture('abandon-unsigned.psbt')
    const signed = fixture('abandon-signed.psbt')
    const field = [0x02, 0xfc, 0x00, 0xfd, 0x10, 0x27, ...new Array(10_000).fill(0x61)]
    const pad = (p: Uint8Array): Uint8Array =>
      Uint8Array.from([...p.subarray(0, 5), ...field, ...p.subarray(5)])
    const maki = await client()
    const r = await maki.btcSign(Network.BITCOIN, pad(unsigned))
    expect(r.approval).toBe('approved')
    expect(r.signed).toEqual(pad(signed))
  }, 20_000)

  it('refuses what isn’t this wallet’s, saying why, without asking', async () => {
    const maki = await client(['--deny'])
    // the test networks' account doesn't own bitcoin's coins
    const r = await maki.btcSign(Network.TESTNET, fixture('abandon-unsigned.psbt'))
    expect(r.approval).toBe('refused')
    expect(r.reason).toMatch(/^input 0 isn't this wallet's/)
    const garbage = await maki.btcSign(
      Network.BITCOIN,
      new TextEncoder().encode('psbt\xffnot really')
    )
    expect(garbage.approval).toBe('refused')
    expect(garbage.reason).toMatch(/^not a PSBT maki can read/)
  })

  it('refuses a PSBT from a different phrase', async () => {
    const maki = await client(['--phrase', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'])
    const r = await maki.btcSign(Network.BITCOIN, fixture('abandon-unsigned.psbt'))
    expect(r).toMatchObject({ approval: 'refused', signed: null })
  })
})
