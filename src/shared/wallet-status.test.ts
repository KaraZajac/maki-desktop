/**
 * WALLET_STATUS: the client reading maki's answer strictly, and the link keeping what each of
 * maki's wallets' apps share apart (wallets.ts), against a maki scripted here (which can open a
 * passphrase wallet, lock, or be firmware from before them) and against the fake maki.
 */
import type { ChildProcess } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'
import { HDKey } from '@scure/bip32'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient, MakiError, type Transport, type WalletStatus } from './client'
import type { EthState } from './ethereum'
import { Link, type WalletStore } from './link'
import {
  Deframer,
  encodeFrame,
  FrameError,
  Kind,
  Network,
  Reader,
  Writer,
  type Packet
} from './protocol'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'
import { ETHEREUM_APP } from './wallet-apps'
import { ANOTHER_WALLET, type WalletId } from './wallets'

type Reply = [kind: number, body: Uint8Array]

const walletReply = (kind: number, fingerprint: number): Reply => [
  Kind.WALLET_STATUS | Kind.REPLY,
  new Writer().u8(kind).u32(fingerprint).finish()
]
const errorReply = (code: number, detail: string): Reply => [
  Kind.ERROR,
  new Writer().u8(code).str8(detail).finish()
]
const UNKNOWN_KIND = errorReply(2, 'unknown message kind')

/** The test phrase's first Ethereum account; and a stand-in for the passphrase wallet's. */
const ADDRESS_PHRASE = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const ADDRESS_PASSPHRASE = '0x00000000000000000000000000000000000B0b0B'

/**
 * A maki that answers as the test says: HELLO and STATUS as any would, WALLET_STATUS with `wallet`,
 * the Ethereum app's account with the address of the wallet it has open, and anything else as
 * firmware that doesn't know it. What it was asked is kept.
 */
class Scripted implements Transport {
  asked: Packet[] = []
  wallet: Reply = walletReply(1, 0x73c5da0a)
  /** a question it's unplugged as it's asked, instead of answering */
  unplugOn: number | null = null
  private deframer = new Deframer()
  private listeners: ((bytes: Uint8Array) => void)[] = []
  private closers: (() => void)[] = []

  /** How many times it was asked `kind`. */
  times(kind: number): number {
    return this.asked.filter((p) => p.kind === kind).length
  }

  async send(bytes: Uint8Array): Promise<void> {
    for (const p of this.deframer.push(bytes)) {
      if (p instanceof FrameError) continue
      this.asked.push(p)
      if (p.kind === this.unplugOn) {
        setTimeout(() => void this.close(), 1)
        continue
      }
      const [kind, body] = this.answer(p)
      const frame = encodeFrame(kind, p.id, body)
      setTimeout(() => this.listeners.forEach((l) => l(frame)), 1)
    }
  }

  private answer(p: Packet): [number, Uint8Array] {
    switch (p.kind) {
      case Kind.HELLO:
        return [Kind.HELLO | Kind.REPLY, new Writer().u8(3).str8('uni').str8('0.2.0').finish()]
      case Kind.STATUS:
        return [Kind.STATUS | Kind.REPLY, new Writer().u8(1).u64(Date.now()).i32(0).finish()]
      case Kind.WALLET_STATUS:
        return this.wallet
      case Kind.APP_MESSAGE: {
        const r = new Reader(p.body)
        const app = r.str8()
        const message = r.bytes16()
        if (app !== ETHEREUM_APP || message[0] !== 0x41)
          return [
            Kind.APP_MESSAGE | Kind.REPLY,
            new Writer().u8(2).bytes16(new Uint8Array()).finish()
          ]
        const address = this.wallet[1][0] === 2 ? ADDRESS_PASSPHRASE : ADDRESS_PHRASE
        const answer = Uint8Array.from([
          0,
          ...new Writer().bytes16(new TextEncoder().encode(address)).finish()
        ])
        return [Kind.APP_MESSAGE | Kind.REPLY, new Writer().u8(0).bytes16(answer).finish()]
      }
      default:
        return UNKNOWN_KIND
    }
  }

  onData(listener: (bytes: Uint8Array) => void): void {
    this.listeners.push(listener)
  }
  onClose(listener: () => void): void {
    this.closers.push(listener)
  }
  async close(): Promise<void> {
    this.closers.forEach((l) => l())
  }
}

describe('reading which wallet maki has', () => {
  const ask = async (reply: Reply): Promise<WalletStatus | null> => {
    const maki = new Scripted()
    maki.wallet = reply
    const status = await new MakiClient(maki).walletStatus()
    // the question is the kind alone, with no body
    expect(maki.asked.map((p) => [p.kind, p.body.length])).toEqual([[Kind.WALLET_STATUS, 0]])
    return status
  }

  it('reads the phrase’s own wallet and a passphrase wallet, each fingerprint as wallets write it', async () => {
    expect(await ask(walletReply(1, 0x73c5da0a))).toEqual({
      kind: 'standard',
      fingerprint: '73c5da0a'
    })
    expect(await ask(walletReply(2, 0xae958f6d))).toEqual({
      kind: 'passphrase',
      fingerprint: 'ae958f6d'
    })
    // little-endian on the wire, as every integer is; eight digits, leading zeros and all
    expect(
      await ask([Kind.WALLET_STATUS | Kind.REPLY, Uint8Array.of(2, 0xef, 0xbe, 0, 0)])
    ).toEqual({ kind: 'passphrase', fingerprint: '0000beef' })
  })

  it('reads no wallet while maki is locked, or has no phrase yet', async () => {
    expect(await ask(walletReply(0, 0))).toEqual({ kind: 'none', fingerprint: null })
  })

  it('takes firmware that doesn’t know the question as saying nothing', async () => {
    expect(await ask(UNKNOWN_KIND)).toBe(null)
  })

  it('refuses an answer that isn’t as the protocol has it', async () => {
    await expect(ask(walletReply(3, 0x73c5da0a))).rejects.toThrow('doesn’t know (3)')
    await expect(ask(walletReply(0xff, 0))).rejects.toThrow('doesn’t know (255)')
    await expect(ask(walletReply(0, 0x73c5da0a))).rejects.toThrow('gave a fingerprint')
    for (const body of [[], [1], [1, 0x0a, 0xda, 0xc5]])
      await expect(ask([Kind.WALLET_STATUS | Kind.REPLY, Uint8Array.from(body)])).rejects.toThrow(
        'ends early'
      )
    await expect(
      ask([Kind.WALLET_STATUS | Kind.REPLY, Uint8Array.of(1, 0x0a, 0xda, 0xc5, 0x73, 0)])
    ).rejects.toThrow('trailing bytes')
    // any other error is one, not old firmware
    await expect(ask(errorReply(1, 'malformed message'))).rejects.toBeInstanceOf(MakiError)
    // nor is an answer to another question
    await expect(ask([Kind.STATUS | Kind.REPLY, walletReply(1, 1)[1]])).rejects.toThrow(
      'expected reply 0x87'
    )
  })
})

/** No Roughtime here: the link sets maki's clock from this computer's, when it's asked to. */
const noRelay = async (): Promise<Uint8Array> => {
  throw new Error('offline')
}

/**
 * What main keeps for the Ethereum objects, as wallet-files.ts does: each wallet's apart, the wallet
 * in use's read, and a save kept only if it's for the wallet in use.
 */
function mainLike(): {
  store: WalletStore<EthState>
  use: (wallet: WalletId) => void
  kept: Map<WalletId, EthState>
  hold: () => () => void
} {
  let inUse: WalletId = null
  const kept = new Map<WalletId, EthState>()
  let held: Promise<void> | null = null
  return {
    store: {
      load: async () => {
        const state = structuredClone(kept.get(inUse) ?? { connected: {}, chains: {} })
        // a load that's slow to come back, while maki switches
        if (held) await held
        return state
      },
      save: async (state, wallet) => {
        if (wallet !== inUse) throw new Error(ANOTHER_WALLET)
        kept.set(wallet, structuredClone(state))
      }
    },
    use: (wallet) => (inUse = wallet),
    kept,
    hold: () => {
      let go = (): void => {}
      held = new Promise((ok) => (go = ok))
      return () => {
        held = null
        go()
      }
    }
  }
}

/** A link to `maki`, telling `told` (as main) each wallet it switches to. */
async function linkTo(
  maki: Scripted,
  main = mainLike()
): Promise<{ link: Link; told: WalletId[] }> {
  const link = new Link(noRelay, undefined, null, {
    rpc: async () => {
      throw new Error('no network')
    },
    store: main.store
  })
  link.autoSync = false
  const told: WalletId[] = []
  link.onWallet = (wallet) => {
    told.push(wallet)
    main.use(wallet)
  }
  expect(await link.attach(maki, 'fake maki')).toBe(true)
  return { link, told }
}

const wait = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))

describe('the link, keeping each wallet’s apart', () => {
  it('takes the wallet maki says as it links, telling main before anything hears of it', async () => {
    const maki = new Scripted()
    maki.wallet = walletReply(2, 0x1a2b3c4d)
    const link = new Link(noRelay)
    link.autoSync = false
    const heard: string[] = []
    link.onWallet = (wallet) => heard.push(`main ${wallet}`)
    link.subscribe(() => heard.push(`news ${link.wallet}`))
    expect(await link.attach(maki, 'fake maki')).toBe(true)
    // asked before anything is shown as linked
    expect(maki.asked.map((p) => p.kind)).toEqual([Kind.HELLO, Kind.STATUS, Kind.WALLET_STATUS])
    expect(link.wallet).toBe('1a2b3c4d')
    expect(link.state.linked && link.state.wallet).toEqual({
      kind: 'passphrase',
      fingerprint: '1a2b3c4d'
    })
    expect(link.log[0]).toMatch(/maki’s wallet apps have passphrase wallet 1a2b3c4d$/)
    expect(heard.filter((h) => h.startsWith('main'))).toEqual(['main 1a2b3c4d'])
    expect(heard.indexOf('main 1a2b3c4d')).toBeLessThan(heard.indexOf('news 1a2b3c4d'))
    link.drop()
  })

  it('says nothing of the phrase’s own wallet, follows maki to a passphrase wallet and back, and keeps the last while maki is locked or away', async () => {
    const maki = new Scripted()
    const { link, told } = await linkTo(maki)
    expect(link.wallet).toBe(null)
    expect(told).toEqual([])
    expect(link.log.join('\n')).not.toMatch(/wallet apps/)

    maki.wallet = walletReply(2, 0x1a2b3c4d)
    expect(await link.walletNow()).toBe('1a2b3c4d')
    expect(told).toEqual(['1a2b3c4d'])

    // locked: which wallet maki has next isn't known, so the last stays
    maki.wallet = walletReply(0, 0)
    expect(await link.walletNow()).toBe('1a2b3c4d')
    expect(link.state.linked && link.state.wallet).toEqual({ kind: 'none', fingerprint: null })
    // unplugged: the same
    link.drop('maki disconnected')
    expect(link.wallet).toBe('1a2b3c4d')
    expect(await link.walletNow()).toBe('1a2b3c4d')
    expect(told).toEqual(['1a2b3c4d'])

    // plugged in again with the phrase's own wallet open
    const again = new Scripted()
    expect(await link.attach(again, 'fake maki')).toBe(true)
    expect(link.wallet).toBe(null)
    expect(told).toEqual(['1a2b3c4d', null])
    expect(link.log[0]).toMatch(/maki’s wallet apps have the phrase’s own wallet again$/)
    link.drop()
  })

  it('isn’t linked to a maki unplugged as it was asked which wallet it has', async () => {
    const maki = new Scripted()
    maki.unplugOn = Kind.WALLET_STATUS
    const link = new Link(noRelay)
    link.autoSync = false
    expect(await link.attach(maki, 'fake maki')).toBe(false)
    expect(link.state.linked).toBe(false)
    expect(link.busy).toBe(false)
    expect(link.log.join('\n')).not.toMatch(/linked to/)
  })

  it('takes firmware from before passphrase wallets as having the phrase’s own, and doesn’t ask it again', async () => {
    const maki = new Scripted()
    maki.wallet = UNKNOWN_KIND
    const { link, told } = await linkTo(maki)
    expect(link.wallet).toBe(null)
    expect(link.state.linked && link.state.wallet).toBe(null)
    await link.walletNow()
    expect(maki.times(Kind.WALLET_STATUS)).toBe(1)
    expect(told).toEqual([])
    expect(link.log.join('\n')).not.toMatch(/wallet/)
    link.drop()
  })

  it('keeps the wallet it has when maki’s answer can’t be read, and says so once', async () => {
    const maki = new Scripted()
    maki.wallet = walletReply(2, 0x1a2b3c4d)
    const { link } = await linkTo(maki)
    maki.wallet = walletReply(7, 0x73c5da0a)
    expect(await link.walletNow()).toBe('1a2b3c4d')
    expect(await link.walletNow()).toBe('1a2b3c4d')
    expect(link.state.linked).toBe(true)
    expect(link.log.filter((l) => l.includes('couldn’t tell which wallet maki has'))).toHaveLength(
      1
    )
    link.drop()
  })

  it('won’t ask a wallet app for one wallet once maki has another open: the message isn’t sent', async () => {
    const maki = new Scripted()
    const { link, told } = await linkTo(maki)
    // the same wallet as ever: the message goes (the app isn't installed, this maki says)
    expect((await link.bitcoin.account(Network.BITCOIN)).approval).toBe('no match')
    expect(maki.times(Kind.APP_MESSAGE)).toBe(1)

    // the owner opens a passphrase wallet on maki, and the heartbeat hasn't heard: a second on
    // from maki's last word, it's asked again before the message goes
    maki.wallet = walletReply(2, 0x1a2b3c4d)
    await wait(1100)
    await expect(link.bitcoin.account(Network.BITCOIN)).rejects.toThrow(ANOTHER_WALLET)
    expect(maki.times(Kind.APP_MESSAGE)).toBe(1)
    expect(link.wallet).toBe('1a2b3c4d')
    expect(told).toEqual(['1a2b3c4d'])
    // the next is the new wallet's, and goes
    expect((await link.bitcoin.account(Network.BITCOIN)).approval).toBe('no match')
    expect(maki.times(Kind.APP_MESSAGE)).toBe(2)
    link.drop()
  })

  it('never hands a site connected under one wallet the other’s account without its being connected again', async () => {
    const maki = new Scripted()
    const main = mainLike()
    const { link } = await linkTo(maki, main)
    const site = async (method: string): Promise<unknown> => {
      const r = await link.fromBrowser({
        id: 1,
        type: 'eth',
        site: 'dapp.example',
        method,
        params: []
      })
      if (r.type !== 'eth') throw new Error('not an Ethereum answer')
      if (r.error) throw new Error(r.error.message)
      return r.result
    }
    expect(await site('eth_requestAccounts')).toEqual([ADDRESS_PHRASE])

    // the owner opens a passphrase wallet on maki; the site connects again, before the heartbeat
    // has heard: maki is asked which wallet first, so it's the passphrase wallet's connection
    maki.wallet = walletReply(2, 0x1a2b3c4d)
    await wait(1100)
    expect(await site('eth_accounts')).toEqual([ADDRESS_PHRASE]) // what it was given: no news to it
    expect(await site('eth_requestAccounts')).toEqual([ADDRESS_PASSPHRASE])
    expect(link.wallet).toBe('1a2b3c4d')

    // back to the phrase's own: the site has its account, and never the passphrase wallet's
    maki.wallet = walletReply(1, 0x73c5da0a)
    await link.walletNow()
    expect(await site('eth_accounts')).toEqual([ADDRESS_PHRASE])
    expect(main.kept.get(null)?.connected).toEqual({ 'dapp.example': ADDRESS_PHRASE })
    expect(main.kept.get('1a2b3c4d')?.connected).toEqual({ 'dapp.example': ADDRESS_PASSPHRASE })

    // and a site connected only under the phrase's own isn't connected under the passphrase wallet
    maki.wallet = walletReply(2, 0x1a2b3c4d)
    await link.walletNow()
    expect(
      await link.fromBrowser({
        id: 2,
        type: 'eth',
        site: 'other.example',
        method: 'eth_accounts',
        params: []
      })
    ).toEqual({ type: 'eth', result: [] })
    link.drop()
  })

  it('turns down a change read under one wallet and finished once maki has another open', async () => {
    const maki = new Scripted()
    const main = mainLike()
    const { link } = await linkTo(maki, main)
    await link.fromBrowser({
      id: 1,
      type: 'eth',
      site: 'dapp.example',
      method: 'eth_requestAccounts',
      params: []
    })
    expect(main.kept.get(null)?.connected).toEqual({ 'dapp.example': ADDRESS_PHRASE })

    // disconnecting the site reads the phrase's own wallet's connections; maki opens a passphrase
    // wallet before it's done
    const go = main.hold()
    const disconnecting = link.ethereum.disconnect('dapp.example')
    maki.wallet = walletReply(2, 0x1a2b3c4d)
    await link.walletNow()
    go()
    await expect(disconnecting).rejects.toThrow(ANOTHER_WALLET)
    // neither wallet's connections changed: the phrase's own still has the site, and the
    // passphrase wallet hasn't had the phrase's written over its own
    expect(main.kept.get(null)?.connected).toEqual({ 'dapp.example': ADDRESS_PHRASE })
    expect(main.kept.has('1a2b3c4d')).toBe(false)
    link.drop()
  })
})

const TEST_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/** A wallet's fingerprint from the test phrase and a passphrase: BIP39's seed, BIP32's master key, worked out here. */
const fingerprintOf = (passphrase: string): string =>
  HDKey.fromMasterSeed(
    pbkdf2Sync(TEST_PHRASE, `mnemonic${passphrase}`.normalize('NFKD'), 2048, 64, 'sha512')
  )
    .fingerprint.toString(16)
    .padStart(8, '0')

describe.skipIf(!FAKE_BUILT)('against the fake maki', () => {
  const fakes: ChildProcess[] = []
  /** whether this fake maki knows the question (one built before passphrase wallets doesn't) */
  let says = false

  const fake = async (args: string[] = []): Promise<number> => {
    const f = await startFake(args)
    fakes.push(f.proc)
    return f.port
  }

  beforeAll(async () => {
    const t = await TcpTransport.open(await fake())
    says = (await new MakiClient(t).walletStatus()) !== null
    await t.close()
  })
  afterAll(() => fakes.forEach((f) => f.kill()))

  it('works its fingerprints out as BIP32 does', () => {
    expect(fingerprintOf('')).toBe('73c5da0a')
  })

  it('says it has the phrase’s own wallet, or the passphrase wallet it was started with', async (ctx) => {
    if (!says) return ctx.skip()
    for (const [args, want] of [
      [[], { kind: 'standard', fingerprint: '73c5da0a' }],
      [['--passphrase', 'maki e2e'], { kind: 'passphrase', fingerprint: fingerprintOf('maki e2e') }]
    ] as const) {
      const t = await TcpTransport.open(await fake([...args]))
      expect(await new MakiClient(t).walletStatus()).toEqual(want)
      await t.close()
    }
  })

  it('links with the passphrase wallet open, and with the phrase’s own again', async (ctx) => {
    if (!says) return ctx.skip()
    const link = new Link(noRelay)
    link.autoSync = false
    const told: WalletId[] = []
    link.onWallet = (w) => told.push(w)
    await link.attach(
      await TcpTransport.open(await fake(['--passphrase', 'maki e2e'])),
      'fake maki'
    )
    expect(link.wallet).toBe(fingerprintOf('maki e2e'))
    link.drop()
    await link.attach(await TcpTransport.open(await fake()), 'fake maki')
    expect(link.wallet).toBe(null)
    expect(told).toEqual([fingerprintOf('maki e2e'), null])
    link.drop()
  })
})
