/**
 * Decoys: the fifteen other outputs each input's ring hides it among, picked as wallet2 picks
 * them (`gamma_picker`, `get_outs`), so a transaction maki desktop makes looks like everyone
 * else's: an age drawn from a gamma distribution fitted to real spending (Möser et al.), turned
 * into an output through the chain's recent rate of outputs per second. The node is asked for 75
 * candidates with the real output among them, sorted, so it can't tell which it is; the ring takes
 * the first fifteen that are unlocked and in the prime-order group, in the order they were picked.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import type { RingMember } from './request'
import type { MoneroNode } from './node'
import { equal, pointOrNull } from './xmr'

const SHAPE = 19.28
const SCALE = 1 / 1.61
/** What a new output waits (10 blocks), and the window a very recent spend's age is drawn from. */
const UNLOCK_SECONDS = 1200
const RECENT_SECONDS = 1800
const BLOCKS_IN_A_YEAR = 262_800
const RING = 16
const REQUESTED = 75

/** A uniform number in [0, 1), from the system's secure randomness. */
function uniform(): number {
  const b = crypto.getRandomValues(new Uint32Array(2))
  // 53 random bits
  return (b[0] * 2 ** 21 + (b[1] >>> 11)) / 2 ** 53
}

/** A uniform integer in [0, n), unbiased. */
function below(n: bigint): bigint {
  if (n <= 0n) return 0n
  const bits = n.toString(2).length
  const bytes = Math.ceil(bits / 8)
  const mask = (1n << BigInt(bits)) - 1n
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(bytes))
    let v = 0n
    for (const x of b) v = (v << 8n) | BigInt(x)
    v &= mask
    if (v < n) return v
  }
}

function normal(): number {
  // Box–Muller
  let u = 0
  while (u === 0) u = uniform()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform())
}

/** Gamma(shape, scale), by Marsaglia and Tsang's method (shape ≥ 1). */
function gamma(shape: number, scale: number): number {
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = normal()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = uniform()
    if (u < 1 - 0.0331 * x ** 4) return d * v * scale
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale
  }
}

/** wallet2's picker, over the chain's cumulative RingCT output counts per block. */
export class GammaPicker {
  private end: number
  /** the outputs at least 10 blocks deep: the ones a ring may use */
  readonly spendable: bigint
  private perOutput: number

  constructor(private offsets: bigint[]) {
    const n = offsets.length
    if (n <= 10) throw new Error('too short a chain to pick decoys from')
    const blocks = Math.min(n, BLOCKS_IN_A_YEAR)
    const outputs = offsets[n - 1] - (blocks < n ? offsets[n - blocks - 1] : 0n)
    this.end = n - 9
    this.spendable = offsets[this.end - 1]
    this.perOutput = (120 * blocks) / Number(outputs)
  }

  /** An output's global index, or null to try again. */
  pick(): bigint | null {
    let x = Math.exp(gamma(SHAPE, SCALE))
    if (x > UNLOCK_SECONDS) x -= UNLOCK_SECONDS
    else x = Math.floor(uniform() * RECENT_SECONDS)
    const back = BigInt(Math.floor(x / this.perOutput))
    if (back >= this.spendable) return null
    const o = this.spendable - 1n - back
    // the first block whose cumulative count reaches o
    let lo = 0
    let hi = this.end
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.offsets[mid] < o) lo = mid + 1
      else hi = mid
    }
    const first = lo === 0 ? 0n : this.offsets[lo - 1]
    const count = this.offsets[lo] - first
    if (count === 0n) return null
    return first + below(count)
  }
}

/** An output being spent, as its ring needs it. */
export interface Spending {
  global: bigint
  key: Uint8Array
  commitment: Uint8Array
}

/**
 * Rings for `spending`, each of 16 in the chain's order, and where the real output is in each.
 * Throws if the node's answer about a real output isn't what the wallet knows of it: a node that
 * made up the rest would learn which is real.
 */
export async function makeRings(
  node: MoneroNode,
  spending: Spending[]
): Promise<{ ring: RingMember[]; real: number }[]> {
  const { offsets } = await node.distribution()
  const picker = new GammaPicker(offsets)
  for (const s of spending) {
    if (s.global >= offsets[offsets.length - 1])
      throw new Error('an output newer than the node’s chain')
  }
  for (let attempt = 0; ; attempt++) {
    // for each input: its own index first, then picks, in the order picked
    const picks: bigint[][] = spending.map((s) => {
      const seen = new Set<bigint>([s.global])
      const order = [s.global]
      if (picker.spendable <= BigInt(REQUESTED)) {
        for (let i = 0n; i < picker.spendable; i++) if (!seen.has(i)) order.push(i)
        return order
      }
      let tries = 0
      while (order.length < REQUESTED && tries++ < 100_000) {
        const i = picker.pick()
        if (i === null || i >= picker.spendable || seen.has(i)) continue
        seen.add(i)
        order.push(i)
      }
      return order
    })
    // asked for sorted, all together: the node can't tell the real one by its place
    const asked = [...new Set(picks.flat())].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const got = await node.outputs(asked)
    const byIndex = new Map(asked.map((i, k) => [i, got[k]]))
    const rings = spending.map((s, n) => {
      const real = byIndex.get(s.global)!
      if (!real.unlocked || !equal(real.key, s.key) || !equal(real.commitment, s.commitment)) {
        throw new Error(
          'the node’s answer about an output being spent isn’t what the chain had: try another node'
        )
      }
      const members: RingMember[] = [{ global: s.global, key: s.key, commitment: s.commitment }]
      for (const i of picks[n].slice(1)) {
        if (members.length === RING) break
        const o = byIndex.get(i)!
        if (!o.unlocked || members.some((m) => m.global === i || equal(m.key, o.key))) continue
        const key = pointOrNull(o.key)
        const commitment = pointOrNull(o.commitment)
        if (!key || !commitment || !key.isTorsionFree() || !commitment.isTorsionFree()) continue
        members.push({ global: i, key: o.key, commitment: o.commitment })
      }
      if (members.length < RING)
        throw new Error('not enough outputs on the chain to hide this one among')
      members.sort((a, b) => (a.global < b.global ? -1 : a.global > b.global ? 1 : 0))
      return { ring: members, real: members.findIndex((m) => m.global === s.global) }
    })
    // the node's own sanity check: mostly different members, and recent enough
    if (
      saneRings(
        rings.map((r) => r.ring),
        offsets[offsets.length - 1]
      ) ||
      attempt >= 2
    )
      return rings
  }
}

/** monerod's `tx_sanity_check`: at least 80% of ring members different, their median in the newest 40%. */
function saneRings(rings: RingMember[][], outputs: bigint): boolean {
  const n = rings.reduce((t, r) => t + r.length, 0)
  if (n <= 10 || outputs < 10_000n) return true
  const distinct = [...new Set(rings.flat().map((m) => m.global))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  if (distinct.length < Math.floor((n * 8) / 10)) return false
  const k = distinct.length
  const median = k % 2 ? distinct[(k - 1) / 2] : (distinct[k / 2 - 1] + distinct[k / 2]) / 2n
  return median >= (outputs * 6n) / 10n
}
