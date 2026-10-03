/**
 * What the Portfolio last found the accounts of each of maki's wallets hold (shared/portfolio.ts),
 * in a file of each wallet's own (wallet-files.ts): amounts, and when they were found out. What's
 * read and written is checked to be only that.
 */
import { readFile } from 'node:fs/promises'
import { emptyKept, keptJson, readKept } from '../shared/portfolio'
import { writeAtomic } from './atomic'
import type { WalletFiles } from './wallet-files'

/** The most the file may be: every look there may be, with room, is far less. */
export const PORTFOLIO_MAX = 256 * 1024

/** What's kept for the wallet in use, as JSON has it (amounts as digits); nothing, if there's none. */
export async function loadPortfolio(files: WalletFiles): Promise<unknown> {
  try {
    return keptJson(readKept(JSON.parse(await readFile(files.path('portfolio'), 'utf8'))))
  } catch {
    return keptJson(emptyKept())
  }
}

/**
 * Keeps `kept` for `wallet`, once checked: only what the Portfolio keeps of it, anything else
 * dropped. Null once kept, or why it wasn't (`wallet` isn't the one in use).
 */
export async function savePortfolio(
  files: WalletFiles,
  kept: unknown,
  wallet: unknown
): Promise<string | null> {
  const refused = files.refuses(wallet)
  if (refused) return refused
  const text = JSON.stringify(keptJson(readKept(kept)))
  if (text.length > PORTFOLIO_MAX) throw new Error('too much to keep')
  await writeAtomic(files.path('portfolio'), text)
  return null
}
