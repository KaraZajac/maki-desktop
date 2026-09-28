/** Sizes, times and amounts as the window shows them. */
import { units } from '../../shared/tokens'

/** A number with at most `places` decimals, none of them trailing zeros. */
const trim = (n: number, places: number): string => n.toFixed(places).replace(/\.?0+$/, '')

/** Bytes as people read them, in KiB and MiB as maki's own screens have them. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) {
    const k = n / 1024
    return `${k < 10 ? trim(k, 1) : Math.round(k)} KiB`
  }
  const m = n / (1024 * 1024)
  return `${m < 10 ? trim(m, 2) : trim(m, 1)} MiB`
}

/** How long ago, in words. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

/**
 * An amount to read at a glance: thousands marked, and at most six places, or for a sliver of a
 * coin, its first four digits after the zeros. The whole of it is a hover away.
 */
export function readable(amount: bigint, decimals: number): string {
  const [whole, frac = ''] = units(amount, decimals).split('.')
  const grouped = BigInt(whole).toLocaleString('en-US')
  const zeros = whole === '0' ? /^0*/.exec(frac)![0].length : 0
  const places = Math.max(6, zeros + 4)
  return frac ? `${grouped}.${frac.slice(0, places)}${frac.length > places ? '…' : ''}` : grouped
}
