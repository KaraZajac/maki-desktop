// TON transfers as @ton/ton and @ton/core make them, for maki desktop's cells (coins/ton.test.ts):
// the test phrase's account 0 as Ledger's TON app makes it (SLIP-10 at m/44'/607'/network'/0'/0'/0',
// @ton/crypto's), in its v4R2 and W5 wallets, on TON and its test network. Each transfer is one the
// wallet makes: TON with a comment or without, to a wallet or a contract; a jetton maki knows, with
// a comment or without; a long comment; a wallet's first, which sets it up. For each, the cell the
// wallet's key signs (the BOC maki is sent), its hash, the signature, and the external message that
// carries it, as @ton/ton and @ton/core write them; and the wallets' code. To make them again:
//   npm install @ton/core@0.63.1 @ton/ton@16.3.0 @ton/crypto@3.3.0 @scure/bip39@2.4.0
//   node make-ton.mjs > ton-transfers.json
import { createHmac } from 'node:crypto'
import { mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { deriveEd25519Path, keyPairFromSeed, sign, signVerify } from '@ton/crypto'
import {
  Address,
  beginCell,
  comment,
  contractAddress,
  external,
  internal,
  SendMode,
  storeMessage
} from '@ton/core'
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton'

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const seed = Buffer.from(mnemonicToSeedSync(phrase))
if (wordlist.length !== 2048) throw new Error('not the BIP-39 word list')

/** SLIP-10 written out, a second implementation for @ton/crypto's. */
function slip10(path) {
  const hmac = (k, d) => createHmac('sha512', k).update(d).digest()
  let i = hmac(Buffer.from('ed25519 seed'), seed)
  for (const n of path) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE((n | 0x80000000) >>> 0)
    i = hmac(i.subarray(32), Buffer.concat([Buffer.from([0]), i.subarray(0, 32), b]))
  }
  return i.subarray(0, 32)
}

const GLOBAL_ID = [-239, -3]
const hex = (b) => Buffer.from(b).toString('hex')
const UNTIL = 1798761600 // 2027-01-01 00:00:00 UTC
const SEQNO = 7

/** The jettons maki knows: their masters, and the library cell for their wallets' code. */
const library = (h) =>
  beginCell().storeUint(2, 8).storeBuffer(Buffer.from(h, 'hex')).endCell({ exotic: true })
const JETTONS = {
  USDT: {
    master: Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'),
    code: library('8f452d7a4dfd74066b682365177259ed05734435be76b5fd4bd5d8af2b7c3d68')
  },
  NOT: {
    master: Address.parse('EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT'),
    code: library('ba2918c8947e9b25af9ac1b883357754173e5812f807a3d6e642a14709595395')
  },
  DOGS: {
    master: Address.parse('EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS'),
    code: library('ba2918c8947e9b25af9ac1b883357754173e5812f807a3d6e642a14709595395')
  }
}
function jettonWallet(name, owner) {
  const { master, code } = JETTONS[name]
  const data = beginCell()
    .storeUint(0, 4)
    .storeCoins(0)
    .storeAddress(owner)
    .storeAddress(master)
    .endCell()
  return contractAddress(0, { code, data })
}

/** TEP-74's transfer, as wallets write it: a comment for the recipient in a reference, or none. */
function jettonTransfer({ amount, to, response, forward }) {
  const b = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(to)
    .storeAddress(response)
    .storeMaybeRef(null)
    .storeCoins(1n)
  if (forward) b.storeBit(1).storeRef(forward)
  else b.storeBit(0)
  return b.endCell()
}

const RECIPIENT = WalletContractV4.create({
  workchain: 0,
  publicKey: keyPairFromSeed(Buffer.alloc(32, 1)).publicKey
}).address
const CONTRACT = new Address(0, Buffer.alloc(32, 0x22))

const out = { phrase, wallets: {}, accounts: [], jettons: {}, transfers: [] }
for (const network of [0, 1]) {
  const path = [44, 607, network, 0, 0, 0]
  const secret = await deriveEd25519Path(seed, path)
  if (!secret.equals(slip10(path))) throw new Error('two SLIP-10s disagree')
  const kp = keyPairFromSeed(secret)
  const wallets = {
    v4R2: WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey }),
    v5R1: WalletContractV5R1.create({
      walletId: { networkGlobalId: GLOBAL_ID[network] },
      publicKey: kp.publicKey
    })
  }
  const testOnly = network === 1
  out.accounts.push({
    network,
    public_key: hex(kp.publicKey),
    ...Object.fromEntries(
      Object.entries(wallets).map(([v, w]) => [
        v,
        {
          raw: w.address.toRawString(),
          bounceable: w.address.toString({ bounceable: true, testOnly }),
          non_bounceable: w.address.toString({ bounceable: false, testOnly }),
          data: hex(w.init.data.toBoc())
        }
      ])
    )
  })
  for (const [version, wallet] of Object.entries(wallets)) {
    out.wallets[version] = { code: hex(wallet.init.code.toBoc()) }
    if (network === 0) {
      out.jettons[version] = Object.fromEntries(
        Object.keys(JETTONS).map((name) => [name, jettonWallet(name, wallet.address).toRawString()])
      )
    }
    const mine = wallet.address
    const transfers = {
      ton: [
        internal({
          to: RECIPIENT,
          value: 1_500_000_000n,
          bounce: false,
          body: comment('invoice 42')
        })
      ],
      contract: [internal({ to: CONTRACT, value: 250_000_000n, bounce: true })],
      usdt: [
        internal({
          to: jettonWallet('USDT', mine),
          value: 50_000_000n,
          bounce: true,
          body: jettonTransfer({
            amount: 5_250_000n,
            to: RECIPIENT,
            response: mine,
            forward: comment('invoice 42')
          })
        })
      ],
      not: [
        internal({
          to: jettonWallet('NOT', mine),
          value: 50_000_000n,
          bounce: true,
          body: jettonTransfer({
            amount: 1_000_000_000_000n,
            to: RECIPIENT,
            response: mine,
            forward: null
          })
        })
      ],
      long: [
        internal({
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
    for (const [name, messages] of Object.entries(transfers)) {
      for (const seqno of name === 'ton' ? [SEQNO, 0] : [SEQNO]) {
        let signing = null
        const signer = async (cell) => {
          signing = cell
          return sign(cell.hash(), kp.secretKey)
        }
        const body = await wallet.createTransfer({
          seqno,
          signer,
          messages,
          sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
          timeout: UNTIL
        })
        const signature =
          version === 'v4R2'
            ? body.bits.substring(0, 512)
            : body.bits.substring(body.bits.length - 512, 512)
        const sig = Buffer.alloc(64)
        for (let i = 0; i < 512; i++) if (signature.at(i)) sig[i >> 3] |= 0x80 >> (i & 7)
        if (!signVerify(signing.hash(), sig, kp.publicKey))
          throw new Error(`${name}: a bad signature`)
        const ext = beginCell()
          .store(
            storeMessage(external({ to: mine, init: seqno === 0 ? wallet.init : undefined, body }))
          )
          .endCell()
        out.transfers.push({
          name,
          network,
          version,
          seqno,
          boc: hex(signing.toBoc()),
          hash: hex(signing.hash()),
          signature: hex(sig),
          external: hex(ext.toBoc())
        })
      }
    }
  }
}
out.recipient = {
  raw: RECIPIENT.toRawString(),
  non_bounceable: RECIPIENT.toString({ bounceable: false }),
  test: RECIPIENT.toString({ bounceable: false, testOnly: true })
}
out.contract = CONTRACT.toString({ bounceable: true })
process.stdout.write(JSON.stringify(out, null, 1) + '\n')
