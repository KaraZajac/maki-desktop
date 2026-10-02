import { describe, expect, it } from 'vitest'
import { NETWORKS_OF } from './btc-wallet'
import { btcFile, isWalletId, walletFileName } from './wallets'

describe('which wallet', () => {
  it('is a passphrase wallet by its fingerprint, eight lowercase hex digits, or null for the phrase’s own', () => {
    expect(isWalletId(null)).toBe(true)
    expect(isWalletId('73c5da0a')).toBe(true)
    expect(isWalletId('0000beef')).toBe(true)
    for (const v of [
      '73C5DA0A',
      '73c5da0',
      '73c5da0a0',
      ' 73c5da0a',
      '73c5da0g',
      '../../x',
      '',
      undefined,
      0x73c5da0a,
      {}
    ])
      expect(isWalletId(v)).toBe(false)
  })
})

describe('each wallet’s files', () => {
  it('keeps the phrase’s own wallet in the files it always had, and a passphrase wallet in its own', () => {
    for (const f of ['accounts', 'ethereum', 'solana', 'monero', 'bitcoin'] as const)
      expect(walletFileName(f, null)).toBe(`${f}.json`)
    expect(walletFileName('accounts', '1a2b3c4d')).toBe('accounts.wallet-1a2b3c4d.json')
    expect(walletFileName('ethereum', 'ae958f6d')).toBe('ethereum.wallet-ae958f6d.json')
    expect(walletFileName('dogecoin', 'ae958f6d')).toBe('dogecoin.wallet-ae958f6d.json')
  })

  it('names no file for something that isn’t a wallet', () => {
    for (const w of ['../x', 'AE958F6D', 'ae958f6d.json', undefined])
      expect(() => walletFileName('accounts', w as never)).toThrow('which wallet?')
  })

  it('gives each chain of Bitcoin’s kind a file of its own, and refuses any other', () => {
    const chains = Object.keys(NETWORKS_OF)
    expect(chains).toEqual(
      expect.arrayContaining(['bitcoin', 'litecoin', 'dogecoin', 'bitcoincash'])
    )
    expect(chains.map(btcFile)).toEqual(chains)
    for (const c of ['', 'ethereum', 'Bitcoin', '__proto__', 'constructor', undefined, null, 0])
      expect(() => btcFile(c)).toThrow('which chain?')
  })
})
