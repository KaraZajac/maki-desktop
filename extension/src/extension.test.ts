// @vitest-environment happy-dom
/**
 * The whole path but the browser: a page (happy-dom) with the content script, the background
 * script, native messaging to the host, the bridge socket, maki desktop's link, and the fake maki
 * running the firmware's protocol logic.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveBridge } from '../../src/main/bridge'
import { readNativeMessages, runNativeHost, writeNativeMessage } from '../../src/main/native-host'
import { Link } from '../../src/shared/link'
import {
  APP_FIXTURES,
  expectedTotp,
  FAKE_BUILT,
  SECRET_B32,
  startFake,
  TcpTransport
} from '../../src/shared/test-support'

const PAGE = 'https://github.com/login'
const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
/** The test phrase's first Solana account, as Phantom has it. */
const SOL_ADDRESS = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'

describe.skipIf(!FAKE_BUILT)('the maki extension, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let server: Server
  let link: Link
  let host: Promise<void>
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  let scratch: string | undefined

  beforeAll(async () => {
    // maki's Ethereum and Solana apps installed, for the page's wallets
    fake = await startFake([
      '--clock-verified',
      '--totp',
      `github.com=${SECRET_B32}`,
      '--app',
      join(APP_FIXTURES, 'ethereum.maki'),
      '--app',
      join(APP_FIXTURES, 'solana.maki')
    ])
    link = new Link(async () => {
      throw new Error('offline')
    })
    link.autoSync = false
    expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
    scratch = mkdtempSync(join(tmpdir(), 'maki-ext-'))
    const sock = join(scratch, 'bridge.sock')
    server = await serveBridge((r) => link.fromBrowser(r), sock)
    host = runNativeHost({ socketPath: sock, input: toHost, output: fromHost })

    // the browser: connectNative is a pipe to the host; runtime messages go to the background
    // script, with the sender the browser would name
    let background: (msg: unknown, sender: object, respond: (r: unknown) => void) => boolean = () => false
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'maki',
        connectNative: () => ({
          postMessage: (m: unknown) => writeNativeMessage(toHost, JSON.stringify(m)),
          onMessage: { addListener: (f: (m: unknown) => void) => readNativeMessages(fromHost, (json) => f(JSON.parse(json)), () => {}) },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {}
        }),
        onMessage: { addListener: (f: typeof background) => (background = f) },
        sendMessage: (msg: unknown) => new Promise((respond) => background(msg, { id: 'maki', url: PAGE }, respond))
      }
    })
    // a page posting to itself: in a browser the event's source is the window, which the
    // provider and the content script check; happy-dom names another object, so post as a
    // browser would
    window.postMessage = ((data: unknown) =>
      setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data, source: window as unknown as MessageEventSource })))) as typeof window.postMessage
    // happy-dom lays nothing out: fields get the size and place they'd have on a page, or the
    // content script takes them for ones nobody can see
    HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(10, 10, 200, 24)
    await import('./background')
    await import('./content')
  })
  afterAll(async () => {
    toHost.end()
    await host
    link?.drop()
    server?.close()
    fake?.proc.kill()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  const page = (html: string): void => {
    document.body.innerHTML = html
  }
  const $ = (sel: string): HTMLInputElement => document.querySelector<HTMLInputElement>(sel)!

  it('asks maki when you click into a login it has nothing for, and fills nothing', async () => {
    page('<form><input type="email" id="u"><input type="password" id="p"></form>')
    $('#p').focus()
    await vi.waitFor(() => expect(link.log.join('\n')).toMatch(/github\.com: login no match/))
    expect($('#u').value + $('#p').value).toBe('')
  })

  it('offers a login you type to maki when you submit it', async () => {
    page('<form><input type="email" id="u"><input type="password" id="p"><button>Sign in</button></form>')
    $('#u').value = 'kara@example.com'
    $('#p').value = 'correct horse'
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(link.log.join('\n')).toMatch(/github\.com: save approved/))
  })

  it('fills that login on the next visit, once approved on maki', async () => {
    page('<form><input type="email" id="u"><input type="password" id="p"></form>')
    $('#u').focus() // the username field asks too
    await vi.waitFor(() => expect($('#p').value).toBe('correct horse'))
    expect($('#u').value).toBe('kara@example.com')
  })

  it('only offers to fill a field the page focused by itself, and asks once that’s taken', async () => {
    const activation = { isActive: false }
    Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true })
    try {
      page('<form><input type="email" id="u2"><input type="password" id="p2"></form>')
      const before = link.log.length
      $('#p2').focus() // a script: no click, tap or key from the owner
      await new Promise((ok) => setTimeout(ok, 300))
      expect(link.log.length).toBe(before) // maki wasn't asked
      expect($('#u2').value + $('#p2').value).toBe('')
      // the owner clicks into it after all
      $('#p2').blur()
      activation.isActive = true
      $('#p2').focus()
      await vi.waitFor(() => expect($('#p2').value).toBe('correct horse'))
    } finally {
      delete (navigator as { userActivation?: unknown }).userActivation
    }
  })

  it('fills a TOTP code, once approved on maki', async () => {
    page('<form><input type="text" name="app_otp" autocomplete="one-time-code" id="otp"></form>')
    $('#otp').focus()
    await vi.waitFor(() => expect($('#otp').value).toMatch(/^\d{6}$/))
    const now = Math.floor(Date.now() / 1000)
    expect([expectedTotp(SECRET_B32, now - 5), expectedTotp(SECRET_B32, now)]).toContain($('#otp').value)
  })

  it('gives the page an Ethereum provider that asks maki', async () => {
    await import('./inpage')
    type Provider = { isMaki: boolean; request(a: object): Promise<unknown>; on(e: string, f: (x: unknown) => void): Provider }
    const eth = (window as unknown as { ethereum: Provider }).ethereum
    expect(eth.isMaki).toBe(true)
    // EIP-6963: wallets announce themselves when a site asks
    const announced: unknown[] = []
    window.addEventListener('eip6963:announceProvider', (e) => announced.push((e as CustomEvent).detail))
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    expect(announced[0]).toMatchObject({ info: { name: 'maki', rdns: 'com.leviathan.maki' } })

    const accounts: unknown[] = []
    eth.on('accountsChanged', (a) => accounts.push(a))
    expect(await eth.request({ method: 'eth_accounts' })).toEqual([])
    expect(await eth.request({ method: 'eth_requestAccounts' })).toEqual([ADDRESS])
    expect(accounts).toEqual([[ADDRESS]])
    expect(await eth.request({ method: 'eth_chainId' })).toBe('0x1')
    const message = `0x${Buffer.from('Sign in to demo.maki').toString('hex')}`
    const fixtures = resolve(__dirname, '../../../xous-core/libs/maki-eth/tests/fixtures/abandon-message.sig')
    const signature = await eth.request({ method: 'personal_sign', params: [message, ADDRESS] })
    if (existsSync(fixtures)) expect(signature).toBe(`0x${readFileSync(fixtures).toString('hex')}`)
    // typed data (EIP-712), signed as the firmware signs it
    const typedFixture = resolve(__dirname, '../../../xous-core/libs/maki-eth/tests/fixtures/abandon-typed.json')
    if (existsSync(typedFixture)) {
      const typedSignature = await eth.request({
        method: 'eth_signTypedData_v4',
        params: [ADDRESS, readFileSync(typedFixture, 'utf8')]
      })
      expect(typedSignature).toBe(`0x${readFileSync(typedFixture.replace('.json', '.sig')).toString('hex')}`)
    }
    // refusals reach the page with their EIP-1193 codes
    await expect(eth.request({ method: 'eth_signTypedData_v3', params: [] })).rejects.toMatchObject({ code: 4200 })
    await expect(eth.request({ method: 'eth_blockNumber' })).rejects.toMatchObject({ code: 4900 })
    expect(link.log.join('\n')).toMatch(/github\.com wants to connect to your Ethereum account/)
  })

  it('gives the page a Solana wallet, as the Wallet Standard has them, that asks maki', async () => {
    await import('./inpage')
    // what a Solana site's wallet adapter does: says it's ready, and wallets register with it
    type Account = { address: string; publicKey: Uint8Array }
    type Wallet = { name: string; chains: string[]; features: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> }
    const wallets: Wallet[] = []
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: (w: Wallet) => wallets.push(w) } }))
    const maki = wallets.find((w) => w.name === 'maki')!
    expect(maki.chains).toEqual(['solana:mainnet', 'solana:devnet'])
    const connect = maki.features['standard:connect'].connect
    expect(await connect({ silent: true })).toEqual({ accounts: [] })
    const { accounts } = (await connect()) as { accounts: Account[] }
    expect(accounts[0].address).toBe(SOL_ADDRESS)
    expect(accounts[0].publicKey).toHaveLength(32)
    // a sign-in, signed with the account's key
    const message = new TextEncoder().encode(`github.com wants you to sign in with your Solana account:\n${SOL_ADDRESS}\n\nNonce: 7`)
    const [signed] = (await maki.features['solana:signMessage'].signMessage({ account: accounts[0], message })) as { signature: Uint8Array }[]
    expect(ed25519.verify(signed.signature, message, accounts[0].publicKey)).toBe(true)
    // a transaction web3.js made, signed as web3.js signs it
    const fixtures = resolve(__dirname, '../../../xous-core/libs/maki-sol/tests/fixtures/transactions.json')
    if (existsSync(fixtures)) {
      const f = (JSON.parse(readFileSync(fixtures, 'utf8')) as { name: string; message: string; signature: string }[]).find((x) => x.name === 'usdc')!
      const transaction = Uint8Array.from([1, ...new Uint8Array(64), ...Buffer.from(f.message, 'hex')])
      const [{ signedTransaction }] = (await maki.features['solana:signTransaction'].signTransaction({ account: accounts[0], transaction })) as {
        signedTransaction: Uint8Array
      }[]
      expect(Buffer.from(signedTransaction.subarray(1, 65)).toString('hex')).toBe(f.signature)
      // sent: maki desktop has no network here, which the page hears
      await expect(
        maki.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: accounts[0], transaction, chain: 'solana:mainnet' })
      ).rejects.toMatchObject({ code: 4900 })
    }
    // another account isn't this site's to use
    await expect(maki.features['solana:signMessage'].signMessage({ account: { address: ADDRESS }, message })).rejects.toMatchObject({ code: 4100 })
    expect(link.log.join('\n')).toMatch(/github\.com wants to connect to your Solana account/)
  })

  it('keeps secrets out of maki desktop’s log', () => {
    expect(link.log.join('\n')).not.toMatch(/correct horse|kara@example\.com|\d{6}/)
  })
})
