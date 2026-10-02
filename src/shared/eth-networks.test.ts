/**
 * maki desktop's Ethereum networks are the ones maki's Ethereum app names, with the same coins and
 * the same word on fees outside the gas (libs/maki-eth/src/display.rs in the firmware repo), and
 * each has what the wallet needs: servers, an explorer, and a price for its coin and tokens.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NETWORKS } from './ethereum'
import { PRICE_IDS, worth } from './prices'
import { TOKENS, tokensOn } from './tokens'

const FIRMWARE = resolve(__dirname, '../../../xous-core/libs/maki-eth/src/display.rs')

/** Test networks maki names that maki desktop has no servers for: Sepolia is the one it has. */
const FIRMWARE_ONLY = [17000n, 560048n, 84532n]

describe('Ethereum networks', () => {
  it.skipIf(!existsSync(FIRMWARE))('are the ones maki names, with the same coins', () => {
    const named = [
      ...readFileSync(FIRMWARE, 'utf8').matchAll(
        /net\((\d+), "([^"]+)", "([^"]+)", (true|false)\)/g
      )
    ].map(([, id, name, unit, outside]) => ({
      chainId: BigInt(id),
      name,
      unit,
      outside: outside === 'true'
    }))
    expect(named.length).toBeGreaterThan(20)
    expect(named.map((n) => n.chainId).filter((id) => !FIRMWARE_ONLY.includes(id))).toEqual(
      expect.arrayContaining(NETWORKS.map((n) => n.chainId))
    )
    expect(NETWORKS.length).toBe(named.length - FIRMWARE_ONLY.length)
    for (const n of NETWORKS) {
      const theirs = named.find((m) => m.chainId === n.chainId)!
      // the same coin, and the same name but for maki's lower case (and its short "arbitrum")
      expect(n.unit).toBe(theirs.unit)
      expect(n.name.toLowerCase().startsWith(theirs.name), n.name).toBe(true)
      // where maki says a network adds fees outside the gas, maki desktop leaves room for them
      expect(n.feesOutsideGas !== undefined).toBe(theirs.outside)
    }
  })

  it('each have servers, an explorer, and one chain ID', () => {
    const ids = NETWORKS.map((n) => n.chainId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(NETWORKS.map((n) => n.name)).size).toBe(NETWORKS.length)
    // Ethereum first: sites start on it, and ENS names are looked up there
    expect(NETWORKS[0].chainId).toBe(1n)
    for (const n of NETWORKS) {
      const servers = [n.rpc, ...n.fallbacks]
      expect(servers.every((s) => /^https:\/\/[^\s/]+\.[a-z]+(\/\S*)?$/.test(s))).toBe(true)
      expect(new Set(servers).size).toBe(servers.length)
      // the explorer's pages are `${explorer}/address/…` and `${explorer}/tx/…`
      expect(n.explorer).toMatch(/^https:\/\/[^\s]+[^/]$/)
    }
    // a server answers for one network: the main process sends a network's calls to its own
    const all = NETWORKS.flatMap((n) => [n.rpc, ...n.fallbacks])
    expect(new Set(all).size).toBe(all.length)
  })

  it('count a coin’s own ERC-20 as the coin', () => {
    const arc = NETWORKS.find((n) => n.name === 'Arc')!
    expect(arc.unit).toBe('USDC')
    expect(tokensOn(arc.chainId).map((t) => [t.symbol, t.contract])).toContainEqual([
      'USDC',
      arc.coinContract
    ])
    expect(NETWORKS.filter((n) => n.coinContract)).toEqual([arc])
  })

  it('have a price for every coin and token, but test networks’', () => {
    const prices = Object.fromEntries(PRICE_IDS.map((id) => [id, 1]))
    for (const n of NETWORKS)
      expect(worth(prices, n.unit, 10n ** 18n, 18, n.test), n.name).toBe(n.test ? null : 1)
    for (const t of TOKENS)
      expect(worth(prices, t.symbol, 10n ** BigInt(t.decimals), t.decimals), t.symbol).toBe(1)
  })
})
