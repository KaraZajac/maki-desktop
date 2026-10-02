// Stellar payments as @stellar/stellar-base builds and signs them, for maki desktop's XDR
// (coins/stellar.test.ts): the test phrase's account 0 by SEP-5 (SLIP-10 at m/44'/148'/0'). To
// make them again: npm install @stellar/stellar-base@15.0.0 && node make-stellar.mjs > stellar-payments.json
import { createHmac, pbkdf2Sync } from 'node:crypto'
import { Account, Asset, Keypair, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-base'

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const seed = pbkdf2Sync(Buffer.from(phrase), Buffer.from('mnemonic'), 2048, 64, 'sha512')
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
const me = Keypair.fromRawEd25519Seed(slip10([44, 148, 0]))
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()
const USDC = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const LONG = new Asset('LONGTOKEN12', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const cases = {
  xlm: [Networks.PUBLIC, Operation.payment({ destination: other, asset: Asset.native(), amount: '12.5' }), Memo.none()],
  memo: [Networks.PUBLIC, Operation.payment({ destination: other, asset: Asset.native(), amount: '0.0000001' }), Memo.text('invoice 42')],
  usdc: [Networks.PUBLIC, Operation.payment({ destination: other, asset: USDC, amount: '3.1415926' }), Memo.none()],
  long: [Networks.TESTNET, Operation.payment({ destination: other, asset: LONG, amount: '1' }), Memo.none()],
  create: [Networks.TESTNET, Operation.createAccount({ destination: other, startingBalance: '1' }), Memo.text('hello')]
}
const out = { address: me.publicKey(), other, cases: {} }
for (const [name, [network, op, memo]] of Object.entries(cases)) {
  const tx = new TransactionBuilder(new Account(me.publicKey(), '123456789012'), { fee: '150', networkPassphrase: network, memo, timebounds: { minTime: 0, maxTime: 1_800_000_000 } })
    .addOperation(op)
    .build()
  const unsigned = tx.toEnvelope().toXDR('base64')
  tx.sign(me)
  out.cases[name] = { network: network === Networks.PUBLIC ? 0 : 1, unsigned, signed: tx.toEnvelope().toXDR('base64'), hash: tx.hash().toString('hex'), signature: tx.signatures[0].signature().toString('hex') }
}
console.log(JSON.stringify(out, null, 2))
