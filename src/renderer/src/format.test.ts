/** Sizes and times as the window shows them. */
import { describe, expect, it } from 'vitest'
import { ago, bytes, readable } from './format'

describe('sizes', () => {
  it('are in KiB and MiB, as maki says them, without trailing zeros', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(1023)).toBe('1023 B')
    expect(bytes(1024)).toBe('1 KiB')
    expect(bytes(9417)).toBe('9.2 KiB')
    expect(bytes(91546)).toBe('89 KiB')
    expect(bytes(2 * 1024 * 1024)).toBe('2 MiB')
    expect(bytes(1_960_000)).toBe('1.87 MiB')
    expect(bytes(12.5 * 1024 * 1024)).toBe('12.5 MiB')
  })
})

describe('times', () => {
  const now = Date.UTC(2026, 8, 27, 22, 0, 0)
  it('say how long ago, then the date', () => {
    expect(ago(now - 10_000, now)).toBe('just now')
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(ago(now - 3 * 3600_000, now)).toBe('3 h ago')
    expect(ago(now - 3 * 86400_000, now)).toMatch(/2026/)
  })
})

describe('amounts', () => {
  it('reads at a glance, and keeps a sliver of a coin from looking like nothing', () => {
    expect(readable(1_234_567_500_000_000_000_000n, 18)).toBe('1,234.5675')
    expect(readable(1_500_000n, 6)).toBe('1.5')
    expect(readable(10n ** 18n, 18)).toBe('1')
    expect(readable(123_456_789n, 8)).toBe('1.234567…')
    expect(readable(1_234_567n, 18)).toBe('0.000000000001234…')
    expect(readable(0n, 18)).toBe('0')
  })
})
