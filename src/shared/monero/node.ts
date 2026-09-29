/**
 * A Monero node (monerod), as maki desktop's wallet asks it things: the chain's height, blocks to
 * scan (`/get_blocks.bin`, pruned, with each output's global index), the outputs decoys are picked
 * from, the fee rates, and sending. The node never sees the view key: maki desktop scans with it
 * here. A remote node sees this computer's IP address, the blocks it asks for, the decoys (the real
 * output among them) and what it sends; your own node sees it all and tells no one.
 *
 * Requests go through `NodeTransport` (the main process, in the app: a page can't reach a node
 * itself).
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { hex } from '@scure/base'
import {
  boolOf,
  bytesOf,
  decodeEpee,
  type EpeeObject,
  encodeEpee,
  type Field,
  listOf,
  numberOf,
  objectsOf,
  statusOf
} from './epee'
import { parseBlock, readTransaction, Reader, type Block, type Transaction } from './transaction'

/** POST `body` to the node's `path`; the answer's bytes. */
export type NodeTransport = (path: string, body: Uint8Array | string) => Promise<Uint8Array>

export interface NodeInfo {
  /** the chain's height: the next block's */
  height: number
  topHash: string
  nettype: string
  synchronized: boolean
  restricted: boolean
}

export interface ScannedBlock {
  height: number
  block: Block
  /** its transactions but the miner's, pruned, with their IDs */
  txs: { id: Uint8Array; tx: Transaction }[]
  /** each transaction's outputs' global indices: the miner's first */
  indices: bigint[][]
}

export interface RingOutput {
  key: Uint8Array
  commitment: Uint8Array
  unlocked: boolean
  height: number
}

export class NodeError extends Error {}

export class MoneroNode {
  constructor(private post: NodeTransport) {}

  private async json(path: string, body: object): Promise<Record<string, unknown>> {
    const got = await this.post(path, JSON.stringify(body))
    let r: Record<string, unknown>
    try {
      r = JSON.parse(new TextDecoder().decode(got)) as Record<string, unknown>
    } catch {
      throw new NodeError(`the node’s answer to ${path} isn’t JSON`)
    }
    return r
  }

  async rpc(method: string, params: object = {}): Promise<Record<string, unknown>> {
    const r = await this.json('/json_rpc', { jsonrpc: '2.0', id: '0', method, params })
    // an error, even of code 0, is one
    if (r.error)
      throw new NodeError(
        `${method}: ${(r.error as { message?: string }).message || 'the node failed'}`
      )
    const result = r.result as Record<string, unknown> | undefined
    if (!result) throw new NodeError(`${method}: no answer`)
    if (typeof result.status === 'string' && result.status !== 'OK')
      throw new NodeError(`${method}: ${result.status}`)
    return result
  }

  private async bin(path: string, fields: Record<string, Field>): Promise<EpeeObject> {
    const r = decodeEpee(await this.post(path, encodeEpee(fields)))
    const status = statusOf(r)
    if (status !== 'OK') throw new NodeError(`${path}: ${status || 'no status'}`)
    return r
  }

  async info(): Promise<NodeInfo> {
    const r = await this.rpc('get_info')
    return {
      height: Number(r.height),
      topHash: String(r.top_block_hash),
      nettype: String(r.nettype),
      synchronized: r.synchronized === true,
      restricted: r.restricted === true
    }
  }

  /** The ID of the block at `height`. */
  async blockHash(height: number): Promise<string> {
    const r = await this.rpc('get_block_header_by_height', { height })
    return String((r.block_header as { hash: string }).hash)
  }

  /**
   * Blocks from `start` (which must be below the chain's height), pruned, at most `max` of them:
   * each one's transactions and their outputs' global indices.
   */
  async blocks(start: number, max = 100): Promise<{ blocks: ScannedBlock[]; height: number }> {
    // from the start, the node wants the genesis block's ID to begin from (else it counts it
    // against this computer, as it does a start past its chain)
    const genesis = start === 0 ? hex.decode(await this.blockHash(0)) : new Uint8Array()
    const r = await this.bin('/get_blocks.bin', {
      block_ids: { bytes: genesis },
      start_height: { u64: start },
      prune: { bool: true },
      max_block_count: { u64: max }
    })
    const first = Number(numberOf(r, 'start_height'))
    const blocks = objectsOf(r, 'blocks')
    const indices = objectsOf(r, 'output_indices')
    if (blocks.length > 0 && first !== start)
      throw new NodeError(`asked for blocks from ${start}, got them from ${first}`)
    if (indices.length !== blocks.length)
      throw new NodeError('blocks without their outputs’ indices')
    const out: ScannedBlock[] = blocks.map((b, i) => {
      const block = parseBlock(bytesOf(b, 'block'))
      const txs = objectsOf(b, 'txs').map((t, j) => {
        const r = new Reader(bytesOf(t, 'blob'))
        const tx = readTransaction(r, true)
        if (!r.done) throw new NodeError('a transaction with bytes after it')
        return { id: block.txHashes[j], tx }
      })
      if (txs.length !== block.txHashes.length)
        throw new NodeError('a block without all its transactions')
      const ix = objectsOf(indices[i], 'indices').map((o) =>
        listOf(o, 'indices').map((v) => v as bigint)
      )
      if (ix.length !== txs.length + 1)
        throw new NodeError('a block’s transactions without their outputs’ indices')
      return { height: start + i, block, txs, indices: ix }
    })
    return { blocks: out, height: Number(numberOf(r, 'current_height')) }
  }

  /**
   * RingCT outputs per block, cumulative, from the first block with any: what decoys are picked
   * by. `offsets[k]` counts the outputs in blocks `start` to `start + k`.
   */
  async distribution(): Promise<{ start: number; offsets: bigint[] }> {
    const r = await this.bin('/get_output_distribution.bin', {
      amounts: { u64s: [0] },
      from_height: { u64: 0 },
      cumulative: { bool: false },
      compress: { bool: true }
    })
    const d = objectsOf(r, 'distributions')[0]
    if (!d) throw new NodeError('no output distribution')
    const start = Number(numberOf(d, 'start_height'))
    let counts: bigint[]
    if (boolOf(d, 'compress')) {
      const data = bytesOf(d, 'compressed_data')
      const rd = new Reader(data)
      counts = []
      while (!rd.done) counts.push(rd.varint())
    } else {
      const data = bytesOf(d, 'distribution')
      counts = Array.from({ length: data.length / 8 }, (_, i) =>
        new DataView(data.buffer, data.byteOffset + 8 * i, 8).getBigUint64(0, true)
      )
    }
    const base = numberOf(d, 'base')
    let sum = base
    return { start, offsets: counts.map((c) => (sum += c)) }
  }

  /** RingCT outputs by global index, as the chain has them. */
  async outputs(indices: bigint[]): Promise<RingOutput[]> {
    const out: RingOutput[] = []
    for (let at = 0; at < indices.length; at += 1000) {
      const chunk = indices.slice(at, at + 1000)
      const r = await this.bin('/get_outs.bin', {
        outputs: { objects: chunk.map((index) => ({ amount: { u64: 0 }, index: { u64: index } })) },
        get_txid: { bool: false }
      })
      const outs = objectsOf(r, 'outs')
      if (outs.length !== chunk.length)
        throw new NodeError('the node answered for fewer outputs than asked')
      for (const o of outs) {
        out.push({
          key: bytesOf(o, 'key'),
          commitment: bytesOf(o, 'mask'),
          unlocked: boolOf(o, 'unlocked'),
          height: Number(numberOf(o, 'height'))
        })
      }
    }
    return out
  }

  /** Fee rates per byte, slow to fastest, and the mask fees are rounded up to. */
  async fees(): Promise<{ rates: bigint[]; mask: bigint }> {
    const r = await this.rpc('get_fee_estimate', { grace_blocks: 10 })
    const rates = Array.isArray(r.fees)
      ? (r.fees as number[]).map((f) => BigInt(f))
      : [BigInt(r.fee as number)]
    return { rates, mask: BigInt((r.quantization_mask as number) || 1) }
  }

  /** Which of these key images are spent: 0 not, 1 in the chain, 2 in the pool. */
  async spent(keyImages: Uint8Array[]): Promise<number[]> {
    const out: number[] = []
    for (let at = 0; at < keyImages.length; at += 1000) {
      const r = await this.json('/is_key_image_spent', {
        key_images: keyImages.slice(at, at + 1000).map((k) => hex.encode(k))
      })
      if (r.status !== 'OK') throw new NodeError(`is_key_image_spent: ${String(r.status)}`)
      out.push(...(r.spent_status as number[]))
    }
    return out
  }

  /** Sends a transaction; why not, if the node says. */
  async send(tx: Uint8Array): Promise<void> {
    const r = await this.json('/send_raw_transaction', {
      tx_as_hex: hex.encode(tx),
      do_not_relay: false,
      do_sanity_checks: true
    })
    if (r.status === 'OK') return
    const why = [
      ['double_spend', 'it spends what’s already spent'],
      ['fee_too_low', 'its fee is too low'],
      ['invalid_input', 'an input isn’t valid'],
      ['invalid_output', 'an output isn’t valid'],
      ['low_mixin', 'its rings are too small'],
      ['sanity_check_failed', 'its decoys don’t look like the chain’s'],
      ['too_big', 'it’s too big'],
      ['too_few_outputs', 'it has too few outputs'],
      ['overspend', 'it spends more than it has'],
      ['tx_extra_too_big', 'its extra is too big'],
      ['nonzero_unlock_time', 'it’s locked']
    ]
      .filter(([flag]) => r[flag] === true)
      .map(([, what]) => what)
    throw new NodeError(
      `the node refused it${why.length ? `: ${why.join(', ')}` : ` (${String(r.status)}${r.reason ? `: ${String(r.reason)}` : ''})`}`
    )
  }
}
