/**
 * maki desktop's own Monero wallet: the chain scanned here with the view key maki shared (the node
 * never sees it), the wallet's outputs and what spent them, its balance, and sending, which maki
 * makes and signs once its owner has gone through it on maki's screen.
 *
 * What spends an output is its key image, which only maki can make: maki desktop asks it for each
 * output's as it finds them (while maki is linked), and sees the wallet's spends in the blocks it
 * scans. Outputs whose key images came later are looked up with the node.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { hex } from '@scure/base'
import type { ViewWallet } from './cold'
import type { MoneroNode, ScannedBlock } from './node'
import { scanTransaction, Subaddresses } from './scan'
import type { Signed } from './request'
import type { Plan } from './send'
import { blockId, parseTransaction, transactionId } from './transaction'
import { equal, mulBase, scalarBytes } from './xmr'

/** An output of the wallet's, as kept. Numbers too big for JavaScript's are strings. */
export interface Output {
  txid: string
  height: number
  /** its index in its transaction, and among all of the chain's RingCT outputs */
  index: number
  global: string
  key: string
  commitment: string
  amount: string
  /** its commitment's mask, hex (a coinbase output's is 1) */
  mask: string
  /** the public key that finds it (its transaction's, or its own additional key) */
  txKey: string
  major: number
  minor: number
  /** when it can be spent: a coinbase output 60 blocks on, any other 10 */
  unlockHeight: number
  keyImage?: string
  /** what spent it: a transaction at a height, or waiting in the pool (null) */
  spent?: { txid: string; height: number | null }
}

/** A payment the wallet made, as maki desktop sent it. */
export interface Sent {
  txid: string
  /** hex, as sent: to send again if it's dropped */
  tx: string
  /** when it was sent (ms) */
  at: number
  fee: string
  to: { address: string; amount: string }[]
  change: string
  /** the outputs it spends, by their keys */
  spends: string[]
  /** the outputs it pays back to the wallet (its change), and their key images, from maki */
  own: [string, string][]
  /** the block it's in, once it's in one */
  height?: number
}

export interface WalletState {
  node: string
  /** the first block scanned: the wallet has nothing before it */
  restoreHeight: number
  /** the next block to scan */
  scanned: number
  /** the last blocks scanned, their IDs: to notice the chain changing under them */
  ids: [number, string][]
  outputs: Output[]
  sent: Sent[]
  /** subaddresses of account 0 handed out to receive to */
  receiveIndex: number
}

export function newWallet(node: string, restoreHeight: number): WalletState {
  return {
    node,
    restoreHeight,
    scanned: restoreHeight,
    ids: [],
    outputs: [],
    sent: [],
    receiveIndex: 0
  }
}

/** How many of account 0's subaddresses scanning looks for past the last used; and of accounts 1 to 3. */
const LOOKAHEAD = 200
const OTHER_ACCOUNTS = 3
const OTHER_LOOKAHEAD = 20
/** Blocks kept IDs of, to notice the chain changing: Monero's deepest reorganisation is 100. */
const KEEP_IDS = 110

export interface Balance {
  total: bigint
  unlocked: bigint
  /** coming in: in the pool, or too recent to spend */
  pending: bigint
}

/**
 * A wallet's balance as its state has it, with the chain at `chainHeight`: from what's kept alone,
 * no keys or node needed (the Portfolio reads it so, and never scans).
 */
export function balanceOf(state: WalletState, chainHeight: number): Balance {
  let total = 0n
  let unlocked = 0n
  let pending = 0n
  for (const o of state.outputs) {
    if (o.spent) continue
    const amount = BigInt(o.amount)
    total += amount
    if (o.unlockHeight <= chainHeight) unlocked += amount
    else pending += amount
  }
  // the change of a payment still waiting for a block: the wallet's, though no block has it yet
  for (const s of state.sent) {
    if (s.height !== undefined || state.outputs.some((o) => o.txid === s.txid)) continue
    total += BigInt(s.change)
    pending += BigInt(s.change)
  }
  return { total, unlocked, pending }
}

export class Wallet {
  private subs: Subaddresses

  constructor(
    readonly keys: ViewWallet,
    public state: WalletState,
    readonly node: MoneroNode
  ) {
    this.subs = new Subaddresses(keys)
    this.cover()
  }

  /** The subaddress table: past the highest one used by LOOKAHEAD, as wallet2 keeps it. */
  private cover(): void {
    const used = (major: number): number =>
      Math.max(
        -1,
        ...this.state.outputs.filter((o) => o.major === major).map((o) => o.minor),
        major === 0 ? this.state.receiveIndex : -1
      )
    this.subs.cover(0, used(0) + 1 + LOOKAHEAD)
    for (let major = 1; major <= OTHER_ACCOUNTS; major++)
      this.subs.cover(major, used(major) + 1 + OTHER_LOOKAHEAD)
  }

  balance(chainHeight: number): Balance {
    return balanceOf(this.state, chainHeight)
  }

  /** Outputs without key images yet: to ask maki for. */
  withoutKeyImages(): Output[] {
    return this.state.outputs.filter((o) => !o.keyImage)
  }

  /**
   * Key images maki made, for outputs found before: each spent one, of those (the blocks scanned
   * before its key image came couldn't tell), is looked up with the node.
   */
  async learnKeyImages(images: { key: string; image: string }[]): Promise<void> {
    const late: Output[] = []
    for (const { key, image } of images) {
      const o = this.state.outputs.find((x) => x.key === key)
      if (!o || o.keyImage) continue
      o.keyImage = image
      if (!o.spent) late.push(o)
    }
    if (late.length === 0) return
    const status = await this.node.spent(late.map((o) => hex.decode(o.keyImage!)))
    late.forEach((o, i) => {
      // spent before this wallet could see it: when, and by what, the chain says (below)
      if (status[i] !== 0)
        o.spent = { txid: '', height: status[i] === 1 ? this.state.scanned - 1 : null }
    })
  }

  /** Scan blocks up to the node's chain height, a batch at a time; `progress` hears each. */
  async sync(progress?: (scanned: number, height: number) => void): Promise<void> {
    for (;;) {
      const info = await this.node.info()
      if (this.state.scanned >= info.height) {
        progress?.(this.state.scanned, info.height)
        return
      }
      const { blocks, height } = await this.node.blocks(this.state.scanned, 100)
      if (blocks.length === 0) return
      if (!this.follows(blocks[0])) {
        await this.reorganise()
        continue
      }
      for (const b of blocks) this.scanBlock(b)
      progress?.(this.state.scanned, height)
    }
  }

  /** Whether a block follows the last one scanned, as far as its ID is kept. */
  private follows(b: ScannedBlock): boolean {
    const last = this.state.ids[this.state.ids.length - 1]
    return !last || last[0] !== b.height - 1 || last[1] === hex.encode(b.block.prevId)
  }

  /**
   * The chain changed under the blocks last scanned: back to where it agrees with them (or, past
   * the IDs kept, to the restore height), forgetting what came after.
   */
  private async reorganise(): Promise<void> {
    let height = this.state.restoreHeight
    for (let i = this.state.ids.length - 1; i >= 0; i--) {
      const [h, id] = this.state.ids[i]
      if ((await this.node.blockHash(h)) === id) {
        height = h + 1
        break
      }
    }
    this.state.ids = this.state.ids.filter(([h]) => h < height)
    this.state.outputs = this.state.outputs.filter((o) => o.height < height)
    for (const o of this.state.outputs)
      if (o.spent && o.spent.height !== null && o.spent.height >= height) delete o.spent
    this.state.scanned = height
  }

  private scanBlock(b: ScannedBlock): void {
    const txs = [{ id: null as Uint8Array | null, tx: b.block.minerTx }, ...b.txs]
    const images = new Map(
      this.state.outputs.filter((o) => o.keyImage).map((o) => [o.keyImage!, o])
    )
    txs.forEach(({ id, tx }, t) => {
      const txid = id ? hex.encode(id) : ''
      // spends of the wallet's outputs, by their key images
      for (const input of tx.inputs) {
        const o = images.get(hex.encode(input.keyImage))
        if (o) o.spent = { txid, height: b.height }
      }
      const sent = this.state.sent.find((x) => x.txid === txid)
      if (sent && txid) sent.height = b.height
      const found = scanTransaction(tx, this.keys, this.subs, b.indices[t] ?? [])
      if (found.length === 0) return
      const coinbase = tx.inputs[0]?.gen !== undefined
      for (const f of found) {
        const key = hex.encode(f.key)
        // the same one-time key twice (the "burning bug"): keep the first, unless it was spent
        // or the new one's bigger
        const had = this.state.outputs.find((o) => o.key === key)
        if (had && (had.spent || BigInt(had.amount) >= f.amount)) continue
        if (had) this.state.outputs.splice(this.state.outputs.indexOf(had), 1)
        this.state.outputs.push({
          txid: coinbase ? hex.encode(transactionId(tx)) : txid,
          height: b.height,
          index: f.index,
          global: f.global.toString(),
          key,
          commitment: hex.encode(f.commitment),
          amount: f.amount.toString(),
          mask: hex.encode(scalarBytes(f.mask)),
          txKey: hex.encode(f.txKey),
          major: f.major,
          minor: f.minor,
          unlockHeight: b.height + (coinbase ? 60 : 10),
          // the change of a payment made here: maki gave its key image with it
          ...(sent ? { keyImage: sent.own.find(([k]) => k === key)?.[1] } : {})
        })
      }
      this.cover()
    })
    this.state.ids.push([b.height, hex.encode(blockId(b.block))])
    if (this.state.ids.length > KEEP_IDS) this.state.ids.splice(0, this.state.ids.length - KEEP_IDS)
    this.state.scanned = b.height + 1
  }

  /**
   * A payment maki signed (`plan`'s): sent through the node, its spends marked (waiting, until a
   * block has it), and kept.
   */
  async send(plan: Plan, signed: Signed): Promise<Sent> {
    const tx = parseTransaction(signed.transaction)
    await this.node.send(signed.transaction)
    const txid = hex.encode(transactionId(tx))
    for (const o of plan.spends) o.spent = { txid, height: null }
    const sent: Sent = {
      txid,
      tx: hex.encode(signed.transaction),
      at: Date.now(),
      fee: plan.request.fee.toString(),
      to: plan.request.payments.map((p) => ({ address: p.address, amount: p.amount.toString() })),
      change: plan.request.change.toString(),
      spends: plan.spends.map((o) => o.key),
      own: signed.own.map((o) => [hex.encode(tx.outputs[o.index].key), hex.encode(o.keyImage)])
    }
    this.state.sent.push(sent)
    return sent
  }

  /** Whether the kept wallet is this one's (its keys). */
  matches(keys: ViewWallet): boolean {
    return (
      equal(keys.spend, this.keys.spend) &&
      equal(mulBase(keys.view).toBytes(), mulBase(this.keys.view).toBytes())
    )
  }
}
