// XRP payments as xrpl.js (5.3.0, ripple-binary-codec 2.11.0) encodes and signs them, for maki
// desktop's encoder (coins/xrp.test.ts), from the test phrase's account at m/44'/144'/0'/0/0, as
// Ledger has it. To make them again: npm install xrpl@5.3.0 && node make-xrp.mjs > xrp-payments.json
import xrpl from 'xrpl'
import codec from 'ripple-binary-codec'
const w = xrpl.Wallet.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', { derivationPath: "m/44'/144'/0'/0/0" })
const base = { TransactionType: 'Payment', Account: w.classicAddress, Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY', Fee: '12', Sequence: 1234, LastLedgerSequence: 99_000_123, SigningPubKey: w.publicKey, Flags: 0 }
const cases = {
  xrp: { ...base, Amount: '1500000' },
  tagged: { ...base, Amount: '25000000', DestinationTag: 3_141_592_653 },
  token: { ...base, Amount: { currency: '524C555344000000000000000000000000000000', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '12.5' } },
  usd: { ...base, Amount: { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', value: '0.000123' } },
  testnet: { ...base, Amount: '1', NetworkID: 21338 }
}
const out = { address: w.classicAddress, publicKey: w.publicKey, cases: {} }
for (const [name, tx] of Object.entries(cases)) {
  const signed = w.sign(tx)
  out.cases[name] = { tx, unsigned: codec.encodeForSigning(tx), signed: signed.tx_blob, hash: signed.hash, signature: codec.decode(signed.tx_blob).TxnSignature }
}
console.log(JSON.stringify(out, null, 2))
