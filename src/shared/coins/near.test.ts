/**
 * maki desktop's NEAR payments against near-api-js 7.3.1 (maki-near's fixtures: tests/fixtures/
 * make.mjs there): every transfer and contract call among them, rebuilt here from its own fields,
 * is near-api-js's transaction byte for byte, and with its signature, the signed transaction and
 * the hash near-api-js gives it.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NEAR_ME, NEAR_THEM, NEAR_USDC, nearStandIn, slip10, TEST_SEED } from '../coin-stand-ins'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import {
  encodeTransaction,
  NEAR,
  type NearAction,
  signedTransaction,
  transactionHash,
  validAccount
} from './near'

const fixtures = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/near-transactions.json'), 'utf8')
) as {
  transactions: { name: string; signed: string | null; signature: string | null; hash: string }[]
}

/** A transaction read back (borsh), if it's only transfers and contract calls. */
function read(b: Uint8Array) {
  let at = 0
  const take = (n: number): Uint8Array => b.slice(at, (at += n))
  const u32 = (): number => new DataView(take(4).buffer).getUint32(0, true)
  const int = (bytes: number): bigint =>
    [...take(bytes)].reduceRight((v, x) => (v << 8n) | BigInt(x), 0n)
  const str = (): string => new TextDecoder().decode(take(u32()))
  const signer = str()
  if (take(1)[0] !== 0) return null
  const publicKey = take(32)
  const nonce = int(8)
  const receiver = str()
  const blockHash = take(32)
  const actions: NearAction[] = []
  for (let n = u32(); n > 0; n--) {
    const kind = take(1)[0]
    if (kind === 3) actions.push({ kind: 'transfer', deposit: int(16) })
    else if (kind === 2) {
      const method = str()
      const args = str()
      actions.push({ kind: 'call', method, args, gas: int(8), deposit: int(16) })
    } else return null
  }
  return at === b.length ? { signer, publicKey, nonce, receiver, blockHash, actions } : null
}

describe('NEAR payments', () => {
  it('are near-api-js’s transactions, signed transactions and hashes, byte for byte', () => {
    const seen: string[] = []
    for (const t of fixtures.transactions) {
      if (!t.signed || !t.signature) continue
      const signed = hex.decode(t.signed)
      const unsigned = signed.slice(0, -65)
      const tx = read(unsigned)
      if (!tx) continue
      // near-api-js writes call arguments as UTF-8 text; a binary one isn't a payment
      if (tx.actions.some((a) => a.kind === 'call' && /[^\x20-\x7e]/.test(a.args))) continue
      expect(hex.encode(encodeTransaction(tx)), t.name).toBe(hex.encode(unsigned))
      expect(hex.encode(signedTransaction(unsigned, hex.decode(t.signature))), t.name).toBe(
        t.signed
      )
      expect(transactionHash(unsigned), t.name).toBe(t.hash)
      seen.push(t.name)
    }
    for (const name of [
      'transfer',
      'transfer-implicit',
      'usdc',
      'usdc-register-and-send',
      'testnet-usdc'
    ])
      expect(seen).toContain(name)
  })

  it('go to NEAR account names, named or implicit', () => {
    for (const ok of ['alice.near', 'usdt.tether-token.near', 'a'.repeat(64), 'wrap.testnet'])
      expect(validAccount(ok), ok).toBe(true)
    for (const bad of [
      'a',
      'Alice.near',
      'alice..near',
      'alice.near.',
      '-alice.near',
      'a'.repeat(65)
    ])
      expect(NEAR.valid(bad, 0), bad).toBe(false)
  })
})

describe('the NEAR wallet', () => {
  const secret = slip10(TEST_SEED, [44, 397, 0])
  const account: SharedAccount = {
    network: 0,
    index: 0,
    address: NEAR_ME,
    // as maki's app gives it: Ed25519's tag, then the key
    publicKey: hex.encode(Uint8Array.of(0, ...ed25519.getPublicKey(secret)))
  }
  const fetchFrom =
    (standIn: ReturnType<typeof nearStandIn>): CoinFetch =>
    async (_network, method, path, body) => {
      const [status, text] = await standIn.answer(method, path, body ?? '')
      return { status, text }
    }
  const sign = (payload: Uint8Array, by = secret): Uint8Array => ed25519.sign(sha256(payload), by)

  it('is the test phrase’s implicit account: its key’s hex', () => {
    expect(hex.encode(ed25519.getPublicKey(secret))).toBe(NEAR_ME)
  })

  it('shows the account, and sends USDC to someone who isn’t signed up for it yet', async () => {
    const standIn = nearStandIn()
    const fetch = fetchFrom(standIn)
    const state = await NEAR.look(fetch, account)
    expect(state.holdings).toEqual([
      { token: null, amount: 12_500_000_000_000_000_000_000_000n },
      { token: { id: NEAR_USDC, symbol: 'USDC', decimals: 6 }, amount: 40_000_000n }
    ])
    // 182 bytes kept on chain, at 10^19 yoctoNEAR each
    expect(state.reserved).toBe(1_820_000_000_000_000_000_000n)
    expect(state.activity.map((a) => [a.kind, a.amount])).toEqual([
      ['Received', 40_000_000n],
      ['Received', 12_500_000_000_000_000_000_000_000n]
    ])
    const p = await NEAR.pay(
      fetch,
      account,
      state,
      NEAR_THEM,
      5_250_000n,
      state.holdings[1].token,
      ''
    )
    expect(p.notes.join(' ')).toMatch(/isn’t signed up/)
    const id = await NEAR.submit(fetch, account, p, sign(p.payload))
    expect(standIn.sent).toEqual([
      {
        hash: id,
        signer: NEAR_ME,
        receiver: NEAR_USDC,
        nonce: 117_000_000_000_001n,
        actions: [
          {
            method: 'storage_deposit',
            args: JSON.stringify({ account_id: NEAR_THEM, registration_only: true }),
            gas: 30_000_000_000_000n,
            deposit: 1_250_000_000_000_000_000_000n
          },
          {
            method: 'ft_transfer',
            args: JSON.stringify({ receiver_id: NEAR_THEM, amount: '5250000' }),
            gas: 30_000_000_000_000n,
            deposit: 1n
          }
        ]
      }
    ])
    // the same again: its nonce is spent
    await expect(NEAR.submit(fetch, account, p, sign(p.payload))).rejects.toThrow(/InvalidNonce/)
  })

  it('opens an implicit account with NEAR, and won’t pay a named one that isn’t there', async () => {
    const standIn = nearStandIn()
    const fetch = fetchFrom(standIn)
    const state = await NEAR.look(fetch, account)
    const fresh = 'ab'.repeat(32)
    const p = await NEAR.pay(fetch, account, state, fresh, 10n ** 24n, null, '')
    expect(p.notes.join(' ')).toMatch(/opens the recipient’s account/)
    // the stand-in turns away what another key signed
    await expect(
      NEAR.submit(fetch, account, p, sign(p.payload, ed25519.utils.randomSecretKey()))
    ).rejects.toThrow(/InvalidSignature/)
    await NEAR.submit(fetch, account, p, sign(p.payload))
    expect(standIn.sent[0]).toMatchObject({ receiver: fresh, actions: [{ transfer: 10n ** 24n }] })
    await expect(
      NEAR.pay(fetch, account, state, 'nobody.near', 10n ** 24n, null, '')
    ).rejects.toThrow(/hasn’t that account/)
  })
})
