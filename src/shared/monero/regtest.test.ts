/**
 * Monero against a live regtest chain (MAKI_REGTEST=1; scripts/regtest.sh starts monerod and
 * monero-wallet-rpc), with the fake maki (the firmware's own Monero app and signing, from the BIP39
 * test phrase). In one file, in order: they share the wallet RPC (one wallet open at a time) and
 * spend from the same wallet.
 *
 * - maki as a view-only wallet's cold wallet: a view-only wallet made from what maki shares, its
 *   outputs' key images from maki imported, and a payment it builds signed by maki, sent and mined.
 * - maki desktop's own wallet: scanning finds what monero-wallet-rpc's full wallet of the same phrase
 *   has, and what's spent; a payment planned here, signed by maki at the size planned, sent, mined,
 *   and its change found.
 */
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { MakiClient } from '../client'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../test-support'
import { MoneroApp, MoneroNetwork } from '../wallet-apps'
import { keyImageFile, signFile, type ViewWallet } from './cold'
import { MoneroNode } from './node'
import { decodeSigned, encodeRequest } from './request'
import { extraLength, planPayment, transactionSize } from './send'
import { parseTransaction, transactionId } from './transaction'
import { newWallet, Wallet } from './wallet'
import { fileKey, openFile, parseKeyImages, parseSigned } from './wallet2'
import { decodeAddress, leNumber, mulBase, subaddressKeys } from './xmr'

const REGTEST = process.env.MAKI_REGTEST === '1'
const NODE = process.env.MAKI_REGTEST_NODE ?? 'http://127.0.0.1:28081'
const WALLET_RPC = process.env.MAKI_REGTEST_WALLET ?? 'http://127.0.0.1:28083'
const TEST_PHRASE = {
  address:
    '49vDbkSo7eve3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVF2N4Zn',
  view: '0f3fe25d0c6d4c94dde0c0bcc214b233e9c72927f813728b0f01f28f9d5e1201'
}

async function rpc(
  url: string,
  method: string,
  params: object = {}
): Promise<Record<string, unknown>> {
  const r = await fetch(`${url}/json_rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params })
  })
  const j = (await r.json()) as { result?: Record<string, unknown>; error?: { message: string } }
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result!
}

const nodeAt = (url: string): MoneroNode =>
  new MoneroNode(async (path, body) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', body })
    return new Uint8Array(await r.arrayBuffer())
  })

/** A block, mined to someone else: what's waiting in the pool goes in it. */
const mine = (): Promise<Record<string, unknown>> =>
  rpc(NODE, 'generateblocks', {
    amount_of_blocks: 1,
    wallet_address:
      '44LozChfYpiYc66YWqqXGfX2Fv8VXV1Q4bwzMB1nD9iweUbEpRS5pRDNBJrKcikigXXQT9tBay1Tp8Btn4MSAsp715HMk66'
  })

describe.skipIf(!REGTEST || !FAKE_BUILT || !APP_FIXTURES_THERE)('Monero on a regtest chain', () => {
  const fakes: ChildProcess[] = []
  afterAll(() => fakes.forEach((p) => p.kill()))
  const monero = async (): Promise<MoneroApp> => {
    const fake = await startFake(['--app', join(APP_FIXTURES, 'monero.maki')])
    fakes.push(fake.proc)
    const c = new MakiClient(await TcpTransport.open(fake.port))
    return new MoneroApp((app, message, timeoutMs) => c.appMessage(app, message, timeoutMs))
  }

  it('signs what a view-only wallet builds, which monerod takes and mines', async () => {
    // whatever an earlier run left waiting, in a block first
    await mine()
    const m = await monero()
    // the view key, once the owner lets this computer watch
    const watched = await m.watch(MoneroNetwork.MONERO)
    expect(watched.approval).toBe('approved')
    const view = leNumber(watched.viewKey!)
    const address = decodeAddress(watched.address)!
    const w: ViewWallet = { network: 'mainnet', spend: address.spend, view }
    const key = fileKey(view)

    // a view-only wallet of it, in monero-wallet-rpc
    const name = `maki-view-${Date.now()}`
    await rpc(WALLET_RPC, 'generate_from_keys', {
      filename: name,
      address: watched.address,
      viewkey: hex.encode(watched.viewKey!),
      password: '',
      restore_height: 0
    })
    await rpc(WALLET_RPC, 'refresh', {})
    const balance = await rpc(WALLET_RPC, 'get_balance', {})
    expect(BigInt(balance.unlocked_balance as number)).toBeGreaterThan(0n)

    // what maki desktop does with the Monero GUI's files, as the RPC hands them over
    const maki = {
      keyImages: (asks: Parameters<MoneroApp['keyImages']>[0]) => m.keyImages(asks),
      sign: (request: Uint8Array) => m.sign(MoneroNetwork.MONERO, request)
    }
    // its outputs' key images, from maki, which wallet2 checks as it imports them
    const exported = await rpc(WALLET_RPC, 'export_outputs', { all: true })
    const made = await keyImageFile(hex.decode(exported.outputs_data_hex as string), w, key, maki)
    const images = parseKeyImages(openFile('keyImages', made.file, view, key))
    expect(images.images.length).toBe(made.outputs)
    const imported = await rpc(WALLET_RPC, 'import_key_images', {
      offset: images.offset,
      signed_key_images: images.images.map((k) => ({
        key_image: hex.encode(k.image),
        signature: hex.encode(k.proof)
      }))
    })
    expect(imported.height).toBeGreaterThan(0)

    // a payment it builds: to a subaddress of another wallet's, and back to itself as change
    const to =
      '8AB7PQPtducdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QZxJwPZ'
    const built = await rpc(WALLET_RPC, 'transfer', {
      destinations: [{ address: to, amount: 1_250_000_000_000 }],
      priority: 0
    })
    const done = await signFile(hex.decode(built.unsigned_txset as string), w, key, maki)
    expect(done.transactions).toBe(1)
    expect(done.fee).toBe(BigInt(built.fee as number))
    const submitted = await rpc(WALLET_RPC, 'submit_transfer', {
      tx_data_hex: hex.encode(done.signed)
    })
    const ids = submitted.tx_hash_list as string[]
    const set = parseSigned(openFile('signed', done.signed, view, key))
    expect(ids).toEqual(set.ptx.map((p) => hex.encode(transactionId(parseTransaction(p.tx.bytes)))))
    // and the key images that go with it, for outputs it had none for: none left, here
    expect(parseKeyImages(openFile('keyImages', done.keyImages, view, key)).images).toEqual([])

    // mined
    await rpc(NODE, 'generateblocks', { amount_of_blocks: 1, wallet_address: watched.address })
    const got = (await (
      await fetch(`${NODE}/get_transactions`, {
        method: 'POST',
        body: JSON.stringify({ txs_hashes: ids })
      })
    ).json()) as { txs: { in_pool: boolean; block_height: number }[] }
    expect(got.txs.length).toBe(ids.length)
    for (const t of got.txs) expect(t.in_pool).toBe(false)
    await rpc(WALLET_RPC, 'close_wallet', {})
  }, 600_000)

  it('finds what monero-wallet-rpc’s full wallet of the same phrase has, and what’s spent', async () => {
    const a = decodeAddress(TEST_PHRASE.address)!
    const keys: ViewWallet = {
      network: 'mainnet',
      spend: a.spend,
      view: leNumber(hex.decode(TEST_PHRASE.view))
    }
    const node = nodeAt(NODE)
    const wallet = new Wallet(keys, newWallet(NODE, 0), node)
    let steps = 0
    await wallet.sync(() => steps++)
    expect(steps).toBeGreaterThan(0)
    const info = await node.info()
    expect(wallet.state.scanned).toBe(info.height)

    await rpc(WALLET_RPC, 'open_wallet', { filename: 'maki', password: '' })
    await rpc(WALLET_RPC, 'refresh')
    const theirs = (await rpc(WALLET_RPC, 'incoming_transfers', { transfer_type: 'all' }))
      .transfers as {
      amount: number
      global_index: number
      pubkey: string
      key_image: string
      spent: boolean
      subaddr_index: { major: number; minor: number }
      tx_hash: string
    }[]
    const ours = wallet.state.outputs
    expect(ours.length).toBe(theirs.length)
    for (const t of theirs) {
      const o = ours.find((x) => x.key === t.pubkey)!
      expect(o, t.pubkey).toBeTruthy()
      expect([o.global, o.amount, o.major, o.minor, o.txid]).toEqual([
        String(t.global_index),
        String(t.amount),
        t.subaddr_index.major,
        t.subaddr_index.minor,
        t.tx_hash
      ])
    }
    // their key images, as maki would make them: what's spent, the node says
    await wallet.learnKeyImages(theirs.map((t) => ({ key: t.pubkey, image: t.key_image })))
    for (const t of theirs)
      expect(!!ours.find((x) => x.key === t.pubkey)!.spent, t.pubkey).toBe(t.spent)

    // scanned again knowing them, the spends are found in the blocks themselves
    const again = new Wallet(
      keys,
      {
        ...wallet.state,
        outputs: ours.map((o) => ({ ...o, spent: undefined })),
        scanned: 0,
        ids: []
      },
      node
    )
    await again.sync()
    for (const t of theirs) {
      const o = again.state.outputs.find((x) => x.key === t.pubkey)!
      expect(!!o.spent, t.pubkey).toBe(t.spent)
      if (t.spent) expect(o.spent!.txid).toMatch(/^[0-9a-f]{64}$/)
    }
    const b = again.balance(info.height)
    expect(b.total).toBe(theirs.filter((t) => !t.spent).reduce((s, t) => s + BigInt(t.amount), 0n))
    await rpc(WALLET_RPC, 'close_wallet')
  }, 300_000)

  it('pays, maki signing a transaction the size and fee planned, which the node takes', async () => {
    const m = await monero()
    const watched = await m.watch(MoneroNetwork.MONERO)
    const a = decodeAddress(watched.address)!
    const keys: ViewWallet = {
      network: 'mainnet',
      spend: a.spend,
      view: leNumber(watched.viewKey!)
    }
    const node = nodeAt(NODE)
    const wallet = new Wallet(keys, newWallet(NODE, 0), node)
    await wallet.sync()

    // key images from maki, for all it found: what's already spent, the node says
    const need = wallet.withoutKeyImages()
    const got = await m.keyImages(
      need.map((o) => ({
        txKey: hex.decode(o.txKey),
        index: BigInt(o.index),
        major: o.major,
        minor: o.minor,
        key: hex.decode(o.key)
      }))
    )
    expect(got.approval).toBe('approved')
    await wallet.learnKeyImages(
      need.map((o, i) => ({ key: o.key, image: hex.encode(got.images[i].image) }))
    )
    const before = wallet.balance((await node.info()).height)

    // two payments: to the wallet's own subaddress 1, and another wallet's address
    const to = [
      {
        address:
          '8AB7PQPtducdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QZxJwPZ',
        amount: 2_000_000_000_000n
      },
      {
        address:
          '44LozChfYpiYc66YWqqXGfX2Fv8VXV1Q4bwzMB1nD9iweUbEpRS5pRDNBJrKcikigXXQT9tBay1Tp8Btn4MSAsp715HMk66',
        amount: 1_500_000_000_000n
      }
    ]
    const plan = await planPayment(wallet, to, 1)
    expect(plan.request.inputs.every((i) => i.ring.length === 16)).toBe(true)
    const signed = await m.sign(MoneroNetwork.MONERO, encodeRequest(plan.request))
    expect(signed.approval, signed.reason).toBe('approved')
    const s = decodeSigned(signed.signed!)
    // maki's transaction is the size planned, so the fee is what the rate asks
    const own = subaddressKeys(keys.view, keys.spend, 0, 0)
    expect(s.transaction.length).toBe(transactionSize(plan.request, extraLength(plan.request, own)))
    const sent = await wallet.send(plan, s)
    expect(sent.own.length).toBe(1)

    // mined: the spends in a block, the change found with its key image, the balance down by what was paid and the fee
    await mine()
    await wallet.sync()
    expect(wallet.state.sent[0].height).toBeGreaterThan(0)
    for (const o of plan.spends) expect(o.spent?.height).toBe(wallet.state.sent[0].height)
    const change = wallet.state.outputs.find((o) => o.key === sent.own[0][0])!
    expect([change.txid, change.amount, change.minor]).toEqual([
      sent.txid,
      plan.request.change.toString(),
      0
    ])
    expect(change.keyImage).toBe(sent.own[0][1])
    const back = wallet.state.outputs.find((o) => o.txid === sent.txid && o.minor === 1)!
    expect(back.amount).toBe('2000000000000')
    // what left: the other wallet's payment and the fee
    const after = wallet.balance((await node.info()).height)
    expect(after.total).toBe(before.total - 1_500_000_000_000n - plan.request.fee)
  }, 600_000)
})
