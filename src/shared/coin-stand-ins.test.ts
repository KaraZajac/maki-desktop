/**
 * The account coins' stand-ins turn away what their networks would: a payment signed by the test
 * phrase's own keys (derived here, as each coin's wallets derive them) is taken, and the same
 * payment changed after signing, or signed by another key, isn't.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { describe, expect, it } from 'vitest'
import {
  stellarStandIn,
  tronStandIn,
  TRX_ME,
  TRX_THEM,
  TRX_USDT,
  XLM_ME,
  XLM_THEM,
  XRP_ME,
  XRP_THEM,
  xrpStandIn
} from './coin-stand-ins'
import { envelope, PASSPHRASE, transactionXdr, type StellarPayment } from './coins/stellar'
import { rawData, signedTransaction } from './coins/tron'
import { encodePayment, type XrpPayment } from './coins/xrp'

/** "abandon" eleven times and "about": BIP 39's seed. */
const SEED = hex.decode(
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'
)
const flip = (b: Uint8Array, at: number): Uint8Array => {
  const c = b.slice()
  c[at] ^= 1
  return c
}

describe('the XRP stand-in', () => {
  const key = HDKey.fromMasterSeed(SEED).derive("m/44'/144'/0'/0/0")
  const payment: XrpPayment = {
    account: XRP_ME,
    destination: XRP_THEM,
    amount: 1_000_000n,
    fee: 12n,
    sequence: 7,
    lastLedgerSequence: 95_000_020,
    signingPubKey: key.publicKey!
  }
  const signed = (by: Uint8Array): Uint8Array => {
    const digest = sha512(Uint8Array.of(0x53, 0x54, 0x58, 0x00, ...encodePayment(payment))).slice(
      0,
      32
    )
    return encodePayment(payment, secp256k1.sign(digest, by, { prehash: false, format: 'der' }))
  }
  const submit = async (blob: Uint8Array, ledger = xrpStandIn()): Promise<string> => {
    const [, text] = await ledger.answer(
      'POST',
      '/',
      JSON.stringify({ method: 'submit', params: [{ tx_blob: hex.encode(blob) }] })
    )
    return (JSON.parse(text) as { result: { engine_result: string } }).result.engine_result
  }

  it('takes the account’s payment, signed by its key', async () => {
    const ledger = xrpStandIn()
    expect(await submit(signed(key.privateKey!), ledger)).toBe('tesSUCCESS')
    expect(ledger.sent).toEqual([
      expect.objectContaining({
        account: XRP_ME,
        destination: XRP_THEM,
        amount: 1_000_000n,
        fee: 12n
      })
    ])
  })

  it('turns away one changed after signing, or signed by another key', async () => {
    const good = signed(key.privateKey!)
    // the amount's last byte (Amount, after TransactionType, Sequence and LastLedgerSequence)
    const amountAt = good.indexOf(0x61) + 8
    expect(await submit(flip(good, amountAt))).toBe('tefBAD_AUTH')
    expect(await submit(signed(secp256k1.utils.randomSecretKey()))).toBe('tefBAD_AUTH')
  })
})

describe('the Stellar stand-in', () => {
  // SLIP-10 on Ed25519, SEP-5's path m/44'/148'/0'
  let node = hmac(sha512, new TextEncoder().encode('ed25519 seed'), SEED)
  for (const i of [44, 148, 0]) {
    const index = Uint8Array.of(0x80 | (i >>> 24), (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff)
    node = hmac(sha512, node.slice(32), Uint8Array.of(0, ...node.slice(0, 32), ...index))
  }
  const secret = node.slice(0, 32)
  const payment: StellarPayment = {
    source: XLM_ME,
    fee: 100,
    sequence: 123_456_789_013n,
    maxTime: BigInt(Math.floor(Date.now() / 1000) + 600),
    memo: '',
    kind: 'payment',
    destination: XLM_THEM,
    asset: 'native',
    amount: 10_000_000n
  }
  const hash = (): Uint8Array =>
    sha256(
      Uint8Array.of(
        ...sha256(new TextEncoder().encode(PASSPHRASE[0])),
        0,
        0,
        0,
        2,
        ...transactionXdr(payment)
      )
    )
  const submit = async (env: Uint8Array, horizon = stellarStandIn()): Promise<number> => {
    const [status] = await horizon.answer(
      'POST',
      `/transactions?tx=${encodeURIComponent(base64.encode(env))}`,
      ''
    )
    return status
  }

  it('takes the account’s payment, signed by its key', async () => {
    const horizon = stellarStandIn()
    expect(await submit(envelope(payment, ed25519.sign(hash(), secret)), horizon)).toBe(200)
    expect(horizon.sent).toEqual([
      expect.objectContaining({
        source: XLM_ME,
        destination: XLM_THEM,
        amount: 10_000_000n,
        asset: null
      })
    ])
  })

  it('turns away one changed after signing, or signed by another key', async () => {
    const good = envelope(payment, ed25519.sign(hash(), secret))
    // the amount's last byte: just before the transaction's ext, its signature count, hint and signature
    expect(await submit(flip(good, good.length - 4 - 4 - 4 - 4 - 64 - 1))).toBe(400)
    expect(
      await submit(envelope(payment, ed25519.sign(hash(), ed25519.utils.randomSecretKey())))
    ).toBe(400)
  })
})

describe('the Tron stand-in', () => {
  const key = HDKey.fromMasterSeed(SEED).derive("m/44'/195'/0'/0/0")
  const raw = rawData({
    refBlockBytes: Uint8Array.of(0x12, 0x34),
    refBlockHash: new Uint8Array(8).fill(7),
    timestamp: Date.now(),
    expiration: Date.now() + 600_000,
    owner: TRX_ME,
    to: TRX_THEM,
    amount: 2_000_000n,
    token: TRX_USDT,
    feeLimit: 9_000_000n
  })
  const sign = (r: Uint8Array, by: Uint8Array): Uint8Array => {
    const sig = secp256k1.sign(sha256(r), by, { prehash: false, format: 'recovered' })
    // noble puts the recovery ID first; Tron's go r, s, then 27 plus it
    return Uint8Array.of(...sig.slice(1), 27 + sig[0])
  }
  const submit = async (tx: Uint8Array, grid = tronStandIn()): Promise<boolean> => {
    const [, text] = await grid.answer(
      'POST',
      '/wallet/broadcasthex',
      JSON.stringify({ transaction: hex.encode(tx) })
    )
    return (JSON.parse(text) as { result: boolean }).result
  }

  it('takes the account’s token payment, signed by its key', async () => {
    const grid = tronStandIn()
    expect(await submit(signedTransaction(raw, sign(raw, key.privateKey!)), grid)).toBe(true)
    expect(grid.sent).toEqual([
      expect.objectContaining({ owner: TRX_ME, to: TRX_THEM, amount: 2_000_000n, token: TRX_USDT })
    ])
  })

  it('turns away one changed after signing, or signed by another key', async () => {
    const sig = sign(raw, key.privateKey!)
    expect(await submit(signedTransaction(flip(raw, raw.length - 1), sig))).toBe(false)
    expect(await submit(signedTransaction(raw, sign(raw, secp256k1.utils.randomSecretKey())))).toBe(
      false
    )
  })
})
