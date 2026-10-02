/**
 * maki desktop's TON wallet against TON's own libraries: cells and BOCs as @ton/core writes them,
 * the test phrase's v4R2 and W5 wallets' addresses and jetton wallets as @ton/ton and the jettons'
 * masters have them, and every transfer the wallet makes, rebuilt from its fields, byte for byte
 * (fixtures/make-ton.mjs): what maki signs, and the external message that carries the signature.
 * Then the wallet against a stand-in for toncenter that reads what it's sent on its own and takes it
 * only if the account's key signed it: what it shows, the payments it makes, and what it refuses.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { hex } from '@scure/base'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  slip10,
  TEST_SEED,
  TON_KEY,
  TON_THEM,
  TON_USDT,
  TON_V4,
  TON_W5,
  tonStandIn
} from '../coin-stand-ins'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import {
  comment,
  externalMessage,
  internalMessage,
  JETTON_TON,
  JETTONS,
  jettonTransfer,
  jettonWallet,
  shownAddress,
  signedBody,
  signingCell,
  TON,
  TON_W5 as W5,
  type TonWallet,
  w5Account,
  history,
  walletAddress,
  walletCode,
  walletData,
  walletId,
  walletInfo,
  walletInit
} from './ton'
import { Cell, friendly, rawAddress, readAddress, readBoc, writeBoc } from './ton-cells'

/** make-ton.mjs's: the test phrase's wallets, their code, and the transfers @ton/ton made. */
const transfers = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/ton-transfers.json'), 'utf8')
) as {
  wallets: Record<TonWallet, { code: string }>
  accounts: ({ network: number; public_key: string } & Record<
    TonWallet,
    { raw: string; bounceable: string; non_bounceable: string; data: string }
  >)[]
  jettons: Record<TonWallet, Record<'USDT' | 'NOT' | 'DOGS', string>>
  transfers: {
    name: string
    network: number
    version: string
    seqno: number
    boc: string
    hash: string
    signature: string
    external: string
  }[]
  recipient: { raw: string; non_bounceable: string; test: string }
  contract: string
}
const UNTIL = 1798761600
const RECIPIENT = readAddress(transfers.recipient.non_bounceable)!.address
const CONTRACT = readAddress(transfers.contract)!.address
const secret = (network: 0 | 1): Uint8Array => slip10(TEST_SEED, [44, 607, network, 0, 0, 0])

describe('TON cells', () => {
  it('read and written as @ton/core writes them, each with its hash', () => {
    for (const t of transfers.transfers) {
      for (const boc of [t.boc, t.external]) {
        const cell = readBoc(hex.decode(boc))
        expect(hex.encode(writeBoc(cell))).toBe(boc)
      }
      expect(hex.encode(readBoc(hex.decode(t.boc)).hash())).toBe(t.hash)
    }
    for (const w of ['v4R2', 'v5R1'] as const)
      expect(hex.encode(writeBoc(walletCode(w)))).toBe(transfers.wallets[w].code)
  })

  it('refuse a BOC whose checksum isn’t its own, or that ends too soon', () => {
    const boc = hex.decode(transfers.transfers[0].boc)
    const bad = boc.slice()
    bad[10] ^= 1
    expect(() => readBoc(bad)).toThrow(/checksum/)
    expect(() => readBoc(boc.subarray(0, boc.length - 9))).toThrow()
  })
})

describe('TON addresses', () => {
  it('are TEP-2’s, both ways', () => {
    const root = readAddress('Ef_lZ1T4NCb2mwkme9h2rJfESCE0W34ma9lWp7-_uY3zXDvq')!
    expect(rawAddress(root.address)).toBe(
      '-1:e56754f83426f69b09267bd876ac97c44821345b7e266bd956a7bfbfb98df35c'
    )
    expect([root.bounceable, root.testOnly]).toEqual([true, false])
    expect(friendly(root.address, false, false)).toBe(
      'Uf_lZ1T4NCb2mwkme9h2rJfESCE0W34ma9lWp7-_uY3zXGYv'
    )
    // base64's own letters read the same; a typo doesn't
    expect(
      rawAddress(readAddress('Ef/lZ1T4NCb2mwkme9h2rJfESCE0W34ma9lWp7+/uY3zXDvq')!.address)
    ).toBe(rawAddress(root.address))
    expect(readAddress('Ef_lZ1T4NCb2mwkme9h2rJfESCE0W34ma9lWp7-_uY3zXDvr')).toBeNull()
    expect(readAddress('Ef/lZ1T4NCb2mwkme9h2rJfESCE0W34ma9lWp7-_uY3zXDvq')).toBeNull()
    expect(readAddress('1:' + 'ab'.repeat(32))).toBeNull()
  })

  it('of the test phrase’s wallets, from its key, as @ton/ton has them', () => {
    for (const a of transfers.accounts) {
      const network = a.network as 0 | 1
      const key = hex.decode(a.public_key)
      expect(hex.encode(ed25519.getPublicKey(secret(network)))).toBe(a.public_key)
      for (const w of ['v4R2', 'v5R1'] as const) {
        expect(rawAddress(walletAddress(w, key, network))).toBe(a[w].raw)
        expect(shownAddress(w, key, network)).toBe(a[w].non_bounceable)
        expect(friendly(walletAddress(w, key, network), true, network === 1)).toBe(a[w].bounceable)
        expect(hex.encode(writeBoc(walletData(w, key, network)))).toBe(a[w].data)
      }
    }
    expect(shownAddress('v4R2', TON_KEY, 0)).toBe(TON_V4)
    expect(shownAddress('v5R1', TON_KEY, 0)).toBe(TON_W5)
  })

  it('of its jetton wallets, as each jetton’s master works them out', () => {
    const key = hex.decode(transfers.accounts[0].public_key)
    for (const w of ['v4R2', 'v5R1'] as const) {
      const mine = walletAddress(w, key, 0)
      for (const j of JETTONS)
        expect(rawAddress(jettonWallet(j, mine))).toBe(
          transfers.jettons[w][j.symbol as 'USDT' | 'NOT' | 'DOGS']
        )
    }
  })
})

describe('TON transfers', () => {
  /** A fixture's messages, rebuilt from its fields. */
  const messages = (name: string, mine: Parameters<typeof jettonWallet>[1]): Cell[] => {
    const usdt = JETTONS.find((j) => j.symbol === 'USDT')!
    const not = JETTONS.find((j) => j.symbol === 'NOT')!
    switch (name) {
      case 'ton':
        return [
          internalMessage({
            to: RECIPIENT,
            value: 1_500_000_000n,
            bounce: false,
            body: comment('invoice 42')
          })
        ]
      case 'contract':
        return [
          internalMessage({ to: CONTRACT, value: 250_000_000n, bounce: true, body: Cell.EMPTY })
        ]
      case 'usdt':
        return [
          internalMessage({
            to: jettonWallet(usdt, mine),
            value: JETTON_TON,
            bounce: true,
            body: jettonTransfer({
              amount: 5_250_000n,
              to: RECIPIENT,
              response: mine,
              comment: 'invoice 42'
            })
          })
        ]
      case 'not':
        return [
          internalMessage({
            to: jettonWallet(not, mine),
            value: JETTON_TON,
            bounce: true,
            body: jettonTransfer({
              amount: 1_000_000_000_000n,
              to: RECIPIENT,
              response: mine,
              comment: ''
            })
          })
        ]
      case 'long':
        return [
          internalMessage({
            to: RECIPIENT,
            value: 1n,
            bounce: false,
            body: comment(
              'a comment longer than a cell holds, so it carries on into the next one, as TON writes long text. '.repeat(
                3
              )
            )
          })
        ]
    }
    throw new Error(name)
  }

  it('are what @ton/ton signs and sends, byte for byte, in both wallets on both networks', () => {
    expect(transfers.transfers).toHaveLength(24)
    for (const t of transfers.transfers) {
      const network = t.network as 0 | 1
      const wallet = t.version as TonWallet
      const key = ed25519.getPublicKey(secret(network))
      const mine = walletAddress(wallet, key, network)
      const signing = signingCell(wallet, {
        walletId: walletId(wallet, network),
        validUntil: UNTIL,
        seqno: t.seqno,
        messages: messages(t.name, mine)
      })
      expect(hex.encode(writeBoc(signing)), `${t.name} ${wallet} ${network}`).toBe(t.boc)
      const signature = ed25519.sign(signing.hash(), secret(network))
      expect(hex.encode(signature)).toBe(t.signature)
      const init = t.seqno === 0 ? walletInit(wallet, key, network) : null
      const message = externalMessage(mine, init, signedBody(wallet, signing, signature))
      expect(hex.encode(writeBoc(message)), `${t.name} ${wallet} ${network}`).toBe(t.external)
    }
  })
})

const fetchFrom =
  (standIn: ReturnType<typeof tonStandIn>): CoinFetch =>
  async (_network, method, path, body) => {
    const [status, text] = await standIn.answer(method, path, body ?? '')
    return { status, text }
  }

/** The test phrase's TON account, as maki's app shares it: its key, and its v4R2 wallet. */
const account: SharedAccount = {
  network: 0,
  index: 0,
  address: TON_V4,
  publicKey: hex.encode(TON_KEY)
}
const sign = (payload: Uint8Array): Uint8Array => ed25519.sign(readBoc(payload).hash(), secret(0))

describe('the TON wallets', () => {
  it('show the v4R2 wallet’s TON and the USDT that’s provably its own, and its history', async () => {
    const fetch = fetchFrom(tonStandIn())
    const state = await TON.look(fetch, account)
    expect(state.holdings).toEqual([
      { token: null, amount: 25_000_000_000n },
      {
        token: { id: TON_USDT, symbol: 'USDT', decimals: 6 },
        amount: 40_000_000n
      }
    ])
    // the jetton naming USDT's master that isn't the account's, and the unknown one: counted
    expect(state.notes.join(' ')).toMatch(/2 jettons maki doesn’t know/)
    // its own USDT jetton wallet's transfer and the TON it got; not the other jetton's "USDT"
    expect(state.activity.map((a) => [a.kind, a.amount, a.token?.symbol ?? 'TON'])).toEqual([
      ['Received', 40_000_000n, 'USDT'],
      ['Received', 25_000_000_000n, 'TON']
    ])
    expect(state.activity[0].counterparty).toBe(TON_THEM)
  })

  it('send TON with a comment from v4R2, signed by the account’s key: toncenter takes it', async () => {
    const standIn = tonStandIn()
    const fetch = fetchFrom(standIn)
    const state = await TON.look(fetch, account)
    const p = await TON.pay(fetch, account, state, TON_THEM, 1_250_000_000n, null, 'invoice 42')
    // toncenter's estimate, said as one
    expect(p.fee).toBe(2_466_670n)
    expect(p.feeIsMost).toBe(false)
    expect(p.notes[0]).toMatch(/about 0.00246667 TON now/)
    // what maki signs: v4R2's request at seqno 7, good for ten minutes
    const signing = readBoc(p.payload)
    expect(signing.bits).toBe(32 * 3 + 8 + 8)
    await expect(TON.submit(fetch, account, p, sign(p.payload).fill(1, 0, 1))).rejects.toThrow(
      /doesn’t check out/
    )
    const id = await TON.submit(fetch, account, p, sign(p.payload))
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(standIn.sent).toEqual([
      {
        wallet: 'v4R2',
        seqno: 7,
        init: false,
        messages: [
          {
            mode: 3,
            to: rawAddress(readAddress(TON_THEM)!.address),
            bounce: false,
            value: 1_250_000_000n,
            comment: 'invoice 42'
          }
        ]
      }
    ])
  })

  it('send USDT through the account’s own jetton wallet, what’s left back to it', async () => {
    const standIn = tonStandIn()
    const fetch = fetchFrom(standIn)
    const state = await TON.look(fetch, account)
    const usdt = state.holdings[1].token
    const p = await TON.pay(fetch, account, state, TON_THEM, 7_250_000n, usdt, 'order 7')
    expect(p.notes.join(' ')).toMatch(/0.05 TON goes with it to the jetton wallets/)
    await TON.submit(fetch, account, p, sign(p.payload))
    const mine = walletAddress('v4R2', TON_KEY, 0)
    expect(standIn.sent[0].messages).toEqual([
      {
        mode: 3,
        to: rawAddress(jettonWallet(JETTONS[0], mine)),
        bounce: true,
        value: 50_000_000n,
        jetton: {
          amount: 7_250_000n,
          to: rawAddress(readAddress(TON_THEM)!.address),
          response: rawAddress(mine),
          forwardTon: 1n,
          comment: 'order 7'
        }
      }
    ])
    await expect(TON.pay(fetch, account, state, TON_THEM, 41_000_000n, usdt, '')).rejects.toThrow(
      /holds 40 USDT/
    )
  })

  it('set the W5 wallet up with its first payment: its first state goes with it', async () => {
    const standIn = tonStandIn()
    const fetch = fetchFrom(standIn)
    const w5 = w5Account(account)
    expect(w5.address).toBe(TON_W5)
    const state = await W5.look(fetch, w5)
    expect(state.holdings).toEqual([{ token: null, amount: 3_000_000_000n }])
    expect(state.notes.join(' ')).toMatch(/isn’t set up on TON yet/)
    const p = await W5.pay(fetch, w5, state, TON_THEM, 1_000_000_000n, null, '')
    expect(p.notes.join(' ')).toMatch(/first payment: it sets the wallet up/)
    await W5.submit(fetch, w5, p, sign(p.payload))
    expect(standIn.sent).toEqual([
      expect.objectContaining({ wallet: 'v5R1', seqno: 0, init: true })
    ])
    // and then it's set up: the next goes at seqno 1, without its first state
    const again = await W5.pay(fetch, w5, await W5.look(fetch, w5), TON_THEM, 1n, null, '')
    await W5.submit(fetch, w5, again, sign(again.payload))
    expect(standIn.sent[1]).toMatchObject({ wallet: 'v5R1', seqno: 1, init: false })
  })

  it('turn down what the wallet can’t pay, and an address for the test network alone', async () => {
    const fetch = fetchFrom(tonStandIn())
    const state = await TON.look(fetch, account)
    await expect(
      TON.pay(fetch, account, state, TON_THEM, 25_000_000_000n, null, '')
    ).rejects.toThrow(/more than the wallet’s 25 TON/)
    const test = friendly(readAddress(TON_THEM)!.address, false, true)
    expect(TON.valid(test, 0)).toBe(false)
    expect(TON.valid(test, 1)).toBe(true)
    await expect(TON.pay(fetch, account, state, test, 1n, null, '')).rejects.toThrow(
      /isn’t a TON address/
    )
  })

  it('says plainly why the wallet turned a payment down: another went first', async () => {
    const fetch = fetchFrom(tonStandIn())
    const state = await TON.look(fetch, account)
    const first = await TON.pay(fetch, account, state, TON_THEM, 1n, null, '')
    const second = await TON.pay(fetch, account, state, TON_THEM, 2n, null, '')
    await TON.submit(fetch, account, first, sign(first.payload))
    await expect(TON.submit(fetch, account, second, sign(second.payload))).rejects.toThrow(
      /seqno has moved on: another payment went first/
    )
  })

  it('won’t take an account whose key and address don’t agree', async () => {
    const fetch = fetchFrom(tonStandIn())
    await expect(TON.look(fetch, { ...account, address: TON_W5 })).rejects.toThrow(/don’t agree/)
  })
})

/** toncenter's answers, as it gave them (2026-10-02). */
const recorded = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/ton-toncenter.json'), 'utf8')
) as {
  walletInformation: Record<'v4R2' | 'v5R1' | 'uninit', unknown>
  actions: { account: string }
  jettonActions: { account: string }
}
const answering =
  (body: unknown): CoinFetch =>
  async () => ({ status: 200, text: JSON.stringify(body) })

describe('toncenter’s answers, as it gives them', () => {
  it('read a wallet’s balance, seqno, contract and wallet ID', async () => {
    expect(await walletInfo(answering(recorded.walletInformation.v4R2), 0, TON_V4)).toEqual({
      balance: 21_968_459_886_270n,
      status: 'active',
      seqno: 373_972,
      type: 'wallet v4 r2',
      id: 698_983_191
    })
    expect(await walletInfo(answering(recorded.walletInformation.v5R1), 0, TON_W5)).toMatchObject({
      type: 'wallet v5 r1',
      id: walletId('v5R1', 0)
    })
    expect(await walletInfo(answering(recorded.walletInformation.uninit), 0, TON_V4)).toEqual({
      balance: 0n,
      status: 'uninit',
      seqno: 0,
      type: null,
      id: null
    })
  })

  it('read TON sent, and USDT sent from the account’s own jetton wallet as its master makes it', async () => {
    const sent = await history(
      answering(recorded.actions),
      0,
      'whoever',
      readAddress(recorded.actions.account)!.address
    )
    expect(sent.map((a) => [a.kind, a.amount, a.token])).toEqual([
      ['Sent', -3_090_500_000n, null],
      ['Sent', -495_200_000n, null],
      ['Sent', -1_228_200_000n, null]
    ])
    expect(sent[0].counterparty).toBe('EQCFJEP4WZ_mpdo0_kMEmsTgvrMHG7K_tWY16pQhKHwoOoy2')
    // an account's USDT, sent through the jetton wallet the indexer names: the one this side works out
    const usdt = await history(
      answering(recorded.jettonActions),
      0,
      'whoever',
      readAddress(recorded.jettonActions.account)!.address
    )
    expect(usdt.map((a) => [a.kind, a.amount, a.token?.symbol])).toEqual([
      ['Sent', -21_750_000n, 'USDT'],
      ['Sent', expect.any(BigInt), 'USDT']
    ])
  })
})

describe('the toncenter stand-in', () => {
  it('turns away a request signed by another key, or changed after signing', async () => {
    const standIn = tonStandIn()
    const fetch = fetchFrom(standIn)
    const state = await TON.look(fetch, account)
    const p = await TON.pay(fetch, account, state, TON_THEM, 1n, null, '')
    const carry = p.carry as { signing: Cell; init: Cell | null }
    const mine = walletAddress('v4R2', TON_KEY, 0)
    const send = async (signature: Uint8Array, signing = carry.signing): Promise<number> => {
      const boc = writeBoc(externalMessage(mine, null, signedBody('v4R2', signing, signature)))
      const [status] = await standIn.answer(
        'POST',
        '/message',
        JSON.stringify({ boc: Buffer.from(boc).toString('base64') })
      )
      return status
    }
    expect(await send(ed25519.sign(carry.signing.hash(), secret(1)))).toBe(500)
    const changed = signingCell('v4R2', {
      walletId: walletId('v4R2', 0),
      validUntil: Math.floor(Date.now() / 1000) + 600,
      seqno: 7,
      messages: [internalMessage({ to: RECIPIENT, value: 2n, bounce: false, body: Cell.EMPTY })]
    })
    expect(await send(ed25519.sign(carry.signing.hash(), secret(0)), changed)).toBe(500)
    expect(standIn.sent).toEqual([])
    expect(await send(ed25519.sign(carry.signing.hash(), secret(0)))).toBe(200)
  })
})
