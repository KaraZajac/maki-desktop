import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAtomic } from './atomic'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'maki-atomic-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('writing a file whole', () => {
  it('replaces it, readable by this user only, with nothing left beside it', async () => {
    const f = join(dir, 'nostr-bunker.json')
    writeFileSync(f, '{"old":true}')
    await writeAtomic(f, '{"new":true}')
    expect(readFileSync(f, 'utf8')).toBe('{"new":true}')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['nostr-bunker.json'])
  })

  it('writes one file one write at a time, the last asked for last', async () => {
    const f = join(dir, 'monero.json')
    const big = (n: number): string => JSON.stringify({ n, pad: 'x'.repeat(2_000_000) })
    await Promise.all([writeAtomic(f, big(1)), writeAtomic(f, big(2)), writeAtomic(f, big(3))])
    expect(JSON.parse(readFileSync(f, 'utf8')).n).toBe(3)
    expect(readdirSync(dir)).toEqual(['monero.json'])
  })

  it('says so when it can’t be written', async () => {
    const f = join(dir, 'gone', 'state.json')
    await expect(writeAtomic(f, 'x')).rejects.toThrow()
  })
})
