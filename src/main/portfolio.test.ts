import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyKept, found, keptJson, readKept } from '../shared/portfolio'
import { ANOTHER_WALLET } from '../shared/wallets'
import { loadPortfolio, savePortfolio } from './portfolio'
import { WalletFiles } from './wallet-files'

let dir: string
let files: WalletFiles
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maki-portfolio-'))
  files = new WalletFiles(() => dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T = 1_790_000_000_000
const tron = (amount: bigint): unknown =>
  keptJson(
    found(
      emptyKept(),
      'tron',
      {
        coin: 'tron',
        where: 'Tron',
        held: [{ symbol: 'TRX', name: 'TRX', amount, decimals: 6 }]
      },
      T
    )
  )

describe('the Portfolio’s file', () => {
  it('is nothing until there is one', async () => {
    expect(await loadPortfolio(files)).toEqual({ looks: {}, days: [] })
  })

  it('keeps each wallet’s apart, and reads the wallet in use’s', async () => {
    expect(await savePortfolio(files, tron(120_000_000n), null)).toBe(null)
    files.use('ae958f6d')
    expect(await loadPortfolio(files)).toEqual({ looks: {}, days: [] })
    expect(await savePortfolio(files, tron(7n), 'ae958f6d')).toBe(null)
    expect(readKept(await loadPortfolio(files)).looks['tron'].held[0].amount).toBe(7n)
    files.use(null)
    expect(readKept(await loadPortfolio(files)).looks['tron'].held[0].amount).toBe(120_000_000n)
    expect(readdirSync(dir).sort()).toEqual(['portfolio.json', 'portfolio.wallet-ae958f6d.json'])
  })

  it('turns down what’s kept for a wallet that isn’t the one in use, and writes nothing', async () => {
    files.use('ae958f6d')
    expect(await savePortfolio(files, tron(1n), null)).toBe(ANOTHER_WALLET)
    expect(await savePortfolio(files, tron(1n), undefined)).toBe(ANOTHER_WALLET)
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps amounts and times alone: anything else sent with them is dropped', async () => {
    const sent = tron(5n) as { looks: Record<string, Record<string, unknown>> }
    sent.looks['tron'].address = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
    sent.looks['tron'].publicKey = '02abc'
    expect(
      await savePortfolio(files, { ...sent, prices: { tron: 0.25 }, view: 'secret' }, null)
    ).toBe(null)
    const text = readFileSync(join(dir, 'portfolio.json'), 'utf8')
    expect(JSON.parse(text)).toEqual(tron(5n))
    expect(text).not.toMatch(/TUEZ|02abc|0\.25|secret/)
  })

  it('reads a file that isn’t one as nothing', async () => {
    writeFileSync(join(dir, 'portfolio.json'), '{"looks": ')
    expect(await loadPortfolio(files)).toEqual({ looks: {}, days: [] })
    writeFileSync(join(dir, 'portfolio.json'), JSON.stringify({ looks: { tron: { coin: 5 } } }))
    expect(await loadPortfolio(files)).toEqual({ looks: {}, days: [] })
  })
})
