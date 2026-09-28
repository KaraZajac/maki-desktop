/**
 * The Ethereum account against the fake maki, which signs with the firmware's own code
 * (maki-eth) from the BIP39 test phrase: the fixtures the emulated firmware signs too
 * (libs/maki-eth/tests/fixtures in the firmware repo).
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'

const FIXTURES = resolve(__dirname, '../../../xous-core/libs/maki-eth/tests/fixtures')
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)))
const HAVE_FIXTURES = existsSync(resolve(FIXTURES, 'abandon-tx-unsigned.bin'))

describe.skipIf(!FAKE_BUILT || !HAVE_FIXTURES)('the Ethereum account', () => {
  const fakes: ChildProcess[] = []
  const client = async (args: string[] = []): Promise<MakiClient> => {
    const fake = await startFake(args)
    fakes.push(fake.proc)
    return new MakiClient(await TcpTransport.open(fake.port))
  }
  afterAll(() => fakes.forEach((p) => p.kill()))

  it('connects a site once the owner agrees', async () => {
    const maki = await client()
    // everyone's first address for the test phrase
    expect(await maki.ethAccount('app.example.com')).toEqual({
      approval: 'approved',
      address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
    })
    expect((await maki.ethAccount('app.example.com', 1)).address).not.toBe(
      '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
    )
  })

  it('signs messages and transactions exactly as the firmware does', async () => {
    const maki = await client()
    const m = await maki.ethSignMessage(
      'demo.maki',
      new TextEncoder().encode('Sign in to demo.maki')
    )
    expect(m).toEqual({ approval: 'approved', signature: fixture('abandon-message.sig') })
    const t = await maki.ethSignTransaction('demo.maki', fixture('abandon-tx-unsigned.bin'))
    expect(t).toEqual({
      approval: 'approved',
      reason: '',
      signed: fixture('abandon-tx-signed.bin')
    })
  })

  it('signs typed data exactly as the firmware does', async () => {
    const maki = await client()
    const json = readFileSync(resolve(FIXTURES, 'abandon-typed.json'), 'utf8')
    expect(await maki.ethSignTypedData('demo.maki', json)).toEqual({
      approval: 'approved',
      reason: '',
      signature: fixture('abandon-typed.sig')
    })
    // in more than one piece
    const spaced = json.replace(/,/g, ',' + ' '.repeat(200))
    expect(new TextEncoder().encode(spaced).length).toBeGreaterThan(4096)
    expect((await maki.ethSignTypedData('demo.maki', spaced)).signature).toEqual(
      fixture('abandon-typed.sig')
    )
    // what maki can't read, it says why
    const r = await maki.ethSignTypedData('demo.maki', json.replace('"EIP712Domain"', '"Domain"'))
    expect(r.approval).toBe('refused')
    expect(r.reason).toMatch(/EIP712Domain/)
  })

  it('gives nothing away when the owner says no, and refuses what it can’t show', async () => {
    const maki = await client(['--deny'])
    expect(await maki.ethAccount('app.example.com')).toEqual({ approval: 'denied', address: '' })
    expect(await maki.ethSignMessage('demo.maki', new Uint8Array([1, 2]))).toEqual({
      approval: 'denied',
      signature: new Uint8Array()
    })
    // a transaction without a chain ID (before EIP-155) could be replayed anywhere
    const pre155 = Uint8Array.from(
      Buffer.from(
        'e9098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080',
        'hex'
      )
    )
    const typed = readFileSync(resolve(FIXTURES, 'abandon-typed.json'), 'utf8')
    expect(await maki.ethSignTypedData('demo.maki', typed)).toEqual({
      approval: 'denied',
      reason: '',
      signature: null
    })
    const r = await maki.ethSignTransaction('demo.maki', pre155)
    expect(r.approval).toBe('refused')
    expect(r.reason).toMatch(/chain ID/)
    // sites must be plain hostnames, as for logins
    await expect(maki.ethAccount('Example.COM')).rejects.toThrow(/bad argument/)
  })
})
