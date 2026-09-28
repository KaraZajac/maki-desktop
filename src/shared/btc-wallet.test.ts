/**
 * maki desktop's Bitcoin wallet against the fake maki (maki's own Bitcoin code, the test phrase's
 * accounts) and a pretend chain: the addresses are the ones BIP84 and BIP86 publish for the test
 * phrase, and a send goes all the way (scan, PSBT, maki's review and signature, broadcast), its
 * signature checked here with noble's own ECDSA and Schnorr.
 */
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hash160 } from '@scure/btc-signer/utils.js'
import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { BtcAccount, Network } from './protocol'
import { BtcWallet, parseDescriptor, REPLACEABLE, walletKey } from './btc-wallet'
import { pretendChain } from './stand-ins'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'

describe.skipIf(!FAKE_BUILT)('the Bitcoin wallet, with the fake maki', () => {
  let fake: { port: number; proc: ChildProcess }
  let transport: TcpTransport
  let client: MakiClient
  beforeAll(async () => {
    fake = await startFake(['--clock-verified'])
    transport = await TcpTransport.open(fake.port)
    client = new MakiClient(transport)
  })
  afterAll(async () => {
    await transport?.close()
    fake?.proc.kill()
  })

  it('works out the addresses BIP84 and BIP86 publish for the test phrase', async () => {
    const segwit = await client.btcAccount(Network.BITCOIN, BtcAccount.SEGWIT)
    const info = parseDescriptor(segwit.descriptor)
    expect(info).toMatchObject({ kind: 'segwit', network: 'bitcoin', fingerprint: 0x73c5da0a })
    const w = new BtcWallet(info, async () => '')
    expect(w.keys.address(0, 0).address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
    expect(w.keys.address(0, 1).address).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g')
    expect(w.keys.address(1, 0).address).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el')

    const taproot = parseDescriptor(
      (await client.btcAccount(Network.BITCOIN, BtcAccount.TAPROOT)).descriptor
    )
    const t = new BtcWallet(taproot, async () => '')
    expect(t.keys.address(0, 0).address).toBe(
      'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
    )
    expect(t.keys.address(0, 1).address).toBe(
      'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh'
    )
    expect(t.keys.address(1, 0).address).toBe(
      'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7'
    )

    // the key wallet software takes on its own: maki's zpub, worked out from the descriptor
    expect(walletKey(info)).toBe(segwit.zpub)
    expect(walletKey(taproot)).toBe(taproot.xpub)
    const test = await client.btcAccount(Network.TESTNET, BtcAccount.SEGWIT)
    expect(walletKey(parseDescriptor(test.descriptor))).toBe(test.zpub)
    expect(test.zpub.startsWith('vpub')).toBe(true)

    expect(() => parseDescriptor('wpkh(xpub)')).toThrow()
  })

  for (const [kind, account] of [
    ['native SegWit', BtcAccount.SEGWIT],
    ['taproot', BtcAccount.TAPROOT]
  ] as const) {
    it(`sends from ${kind}: maki signs what the wallet made, and the signature checks out`, async () => {
      const info = parseDescriptor((await client.btcAccount(Network.BITCOIN, account)).descriptor)
      const receive = new BtcWallet(info, async () => '').keys.address(0, 0)
      const chain = pretendChain(receive.address, 100_000)
      const wallet = new BtcWallet(info, chain.esplora)

      const state = await wallet.scan()
      expect(state.activity.map((a) => a.net)).toEqual([100_000n])
      expect(state.confirmed).toBe(100_000n)
      expect(state.receive.index).toBe(1)
      expect(state.change.index).toBe(0)

      const payee = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
      const made = await wallet.send(state, payee, 30_000n, 2)
      expect(made.sent).toBe(30_000n)
      expect(made.fee + made.change + made.sent).toBe(100_000n)

      // maki reviews it (the payment, its change as change, the fee) and signs
      const r = await client.btcSign(Network.BITCOIN, made.psbt)
      expect(r.approval, r.reason).toBe('approved')
      await wallet.broadcast(r.signed!)
      const tx = btc.Transaction.fromRaw(hex.decode(chain.broadcast[0]))
      expect(tx.inputsLength).toBe(1)
      expect(tx.getInput(0).sequence).toBe(REPLACEABLE)
      expect(tx.getInput(0).txid && hex.encode(tx.getInput(0).txid!)).toBe(chain.txid)
      expect(tx.getOutput(0).amount).toBe(30_000n)
      expect(tx.getOutput(1).script).toEqual(state.change.script)

      // the signature, checked here: noble's ECDSA or Schnorr over the digest btc-signer makes
      const witness = tx.getInput(0).finalScriptWitness!
      if (account === BtcAccount.SEGWIT) {
        const [sig, pub] = witness
        expect(pub).toEqual(receive.publicKey)
        const code = btc.OutScript.encode({ type: 'pkh', hash: hash160(receive.publicKey) })
        const digest = tx.preimageWitnessV0(0, code, btc.SigHash.ALL, 100_000n)
        expect(
          secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })
        ).toBe(true)
      } else {
        const [sig] = witness
        const outputKey = receive.script.slice(2)
        const digest = tx.preimageWitnessV1(
          0,
          [receive.script],
          sig.length === 65 ? sig[64] : btc.SigHash.DEFAULT,
          [100_000n]
        )
        expect(schnorr.verify(sig.slice(0, 64), digest, outputKey)).toBe(true)
      }
    })
  }

  it('looks again only at the addresses that changed', async () => {
    const info = parseDescriptor(
      (await client.btcAccount(Network.BITCOIN, BtcAccount.SEGWIT)).descriptor
    )
    const address = new BtcWallet(info, async () => '').keys.address(0, 0).address
    const chain = pretendChain(address, 50_000)
    const asked: string[] = []
    const w = new BtcWallet(info, async (network, path, body) => {
      asked.push(path)
      return chain.esplora(network, path, body)
    })
    const first = await w.scan()
    expect(first.confirmed).toBe(50_000n)
    expect(asked.filter((p) => p.endsWith('/txs') || p.endsWith('/utxo'))).toEqual([
      `/address/${address}/utxo`,
      `/address/${address}/txs`
    ])
    asked.length = 0
    const again = await w.scan()
    expect(again).toEqual(first)
    // its stats, and the gap after it: nothing it already had
    expect(asked.some((p) => p.endsWith('/txs') || p.endsWith('/utxo'))).toBe(false)
  })

  it('speeds up a payment still waiting for a block: the same coin and payment, more fee from the change', async () => {
    const info = parseDescriptor(
      (await client.btcAccount(Network.BITCOIN, BtcAccount.SEGWIT)).descriptor
    )
    const keys = new BtcWallet(info, async () => '').keys
    const coin = keys.address(0, 0)
    const chain = pretendChain(coin.address, 100_000)
    const w = new BtcWallet(info, chain.esplora)
    const payee = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
    const first = await w.send(await w.scan(), payee, 30_000n, 2)
    const txid1 = await w.broadcast((await client.btcSign(Network.BITCOIN, first.psbt)).signed!)

    // waiting for a block, at about 2 sat/vB, and replaceable
    const waiting = (await w.scan()).activity.find((a) => a.txid === txid1)!
    expect(waiting).toMatchObject({ time: null, replaceable: true, net: -(30_000n + first.fee) })
    expect(waiting.rate).toBeCloseTo(2, 0)
    // again at 12 sat/vB: maki signs it like any payment, and it takes the first one's place
    const bumped = await w.bump(txid1, 12)
    expect(bumped.was).toBe(first.fee)
    expect(bumped.fee).toBeGreaterThan(first.fee * 5n)
    const signed = await client.btcSign(Network.BITCOIN, bumped.psbt)
    expect(signed.approval).toBe('approved')
    const txid2 = await w.broadcast(signed.signed!)
    expect([chain.chain.waiting(txid1), chain.chain.waiting(txid2)]).toEqual([false, true])

    const tx = btc.Transaction.fromRaw(hex.decode(chain.broadcast[1]))
    expect(hex.encode(tx.getInput(0).txid!)).toBe(chain.txid)
    expect(tx.getInput(0).sequence).toBe(REPLACEABLE)
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(
      payee
    )
    expect(tx.getOutput(0).amount).toBe(30_000n)
    // the change pays the difference
    expect(tx.getOutput(1).amount).toBe(first.change - (bumped.fee - first.fee))
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(tx.getOutput(1).script!))).toBe(
      keys.address(1, 0).address
    )
    const [sig, pub] = tx.getInput(0).finalScriptWitness!
    const code = btc.OutScript.encode({ type: 'pkh', hash: hash160(pub) })
    const digest = tx.preimageWitnessV0(0, code, btc.SigHash.ALL, 100_000n)
    expect(secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })).toBe(
      true
    )

    // the next look has the new one and not the old; what's in a block can't be sped up
    const after = (await w.scan()).activity.map((a) => a.txid)
    expect(after).toContain(txid2)
    expect(after).not.toContain(txid1)
    await expect(w.bump(chain.txid, 20)).rejects.toThrow('waiting for a block')
  })

  it('says when there isn’t enough, and what it won’t send to', async () => {
    const info = parseDescriptor(
      (await client.btcAccount(Network.BITCOIN, BtcAccount.SEGWIT)).descriptor
    )
    const chain = pretendChain(
      new BtcWallet(info, async () => '').keys.address(0, 0).address,
      10_000
    )
    const wallet = new BtcWallet(info, chain.esplora)
    const state = await wallet.scan()
    await expect(
      wallet.send(state, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 20_000n, 2)
    ).rejects.toThrow(/doesn’t hold enough/)
    await expect(
      wallet.send(state, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 1_000n, 2)
    ).rejects.toThrow(/isn’t a Bitcoin address/)
    // all of it, less the fee: no change
    const all = await wallet.send(state, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'all', 2)
    expect(all.sent + all.fee).toBe(10_000n)
    expect(all.change).toBe(0n)
  })
})
