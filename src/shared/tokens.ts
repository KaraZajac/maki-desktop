/**
 * Tokens maki knows by their contracts (libs/maki-eth/src/tokens.rs in the firmware repo): the
 * same table, so the balances here and the amounts maki shows when one is sent agree. Each was
 * checked against its contract's own symbol() and decimals(). tokens.test.ts keeps the two alike.
 */

export interface Token {
  chainId: bigint
  /** checksummed, as the table has it */
  contract: string
  symbol: string
  decimals: number
}

const token = (chainId: number, contract: string, symbol: string, decimals: number): Token => ({
  chainId: BigInt(chainId),
  contract,
  symbol,
  decimals
})

export const TOKENS: Token[] = [
  token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6),
  token(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 6),
  token(1, '0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI', 18),
  token(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH', 18),
  token(1, '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 8),
  token(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 6),
  token(8453, '0x4200000000000000000000000000000000000006', 'WETH', 18),
  token(10, '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC', 6),
  token(10, '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'USDT', 6),
  token(10, '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI', 18),
  token(10, '0x4200000000000000000000000000000000000006', 'WETH', 18),
  token(42161, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC', 6),
  token(42161, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USDT0', 6),
  token(42161, '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI', 18),
  token(42161, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH', 18),
  token(137, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC', 6),
  token(137, '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT0', 6),
  token(137, '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 'DAI', 18),
  token(137, '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'WETH', 18)
]

export function tokensOn(chainId: bigint): Token[] {
  return TOKENS.filter((t) => t.chainId === chainId)
}

/** An amount in a token's (or a coin's) smallest units, as people write it: exactly, no trailing zeros. */
export function units(amount: bigint, decimals: number): string {
  const negative = amount < 0n
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : ''
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** What someone typed, in a token's smallest units; null if it isn't an amount of it. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(text)
  if (!m || (!m[1] && !m[2])) return null
  const frac = m[2] ?? ''
  if (frac.length > decimals) return null
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}
