/**
 * Kaspa, for maki desktop's wallet: the account maki's Kaspa app shares (its key and chain code at
 * m/44'/111111'/0', so every address it will have: receiving `/0/i` and change `/1/i`, Schnorr
 * keys'), the addresses it has used, found by asking api.kaspa.org; what they hold; and payments
 * made as the app takes them to sign (maki-kas's `request`: the transaction, each coin it spends
 * with what it holds and its key, and which output is change), priced by their mass as Kaspa's own
 * wallet prices it, then sent with each input's signature in its script.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { blake2b } from '@noble/hashes/blake2.js'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import type { AccountChain, Activity, ChainState } from '../account-chain'
import { decodeCashBytes, encodeCashBytes } from '../cashaddr'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import { KASPA_APP } from '../wallet-apps'

/** Sompi in a KAS. */
export const SOMPI = 100_000_000n
/** Each network's addresses' prefix. */
const PREFIX = ['kaspa', 'kaspatest'] as const
/** Used addresses are looked for this many at a time, until a batch has none (BIP 44's gap). */
const GAP = 20
/** The most coins a payment spends: what fits a message to maki with two outputs (maki-kas's). */
export const MAX_INPUTS = 41
/** A mined coin can't be spent for this long (in DAA score: 100 seconds at ten blocks a second). */
const COINBASE_MATURITY = 1000n

// Kaspa's mass (rusty-kaspa's wallet's MassCalculator, its consensus parameters)
const MASS_PER_TX_BYTE = 1n
const MASS_PER_SCRIPT_PUB_KEY_BYTE = 10n
const MASS_PER_SIG_OP = 1000n
/** KIP-9's C: what storage mass charges a small output. */
const STORAGE_MASS_PARAMETER = SOMPI * 10_000n
/** The most mass a transaction may have and be relayed. */
export const MAX_MASS = 100_000n
/** The least fee a gram of mass pays to be relayed (rusty-kaspa 2.1's), sompi. */
const MIN_FEERATE = 100

/** The script that pays an address: a Schnorr key's, an ECDSA key's, or a script hash's. */
export function scriptOf(address: string, network: 0 | 1): Uint8Array | null {
  const b = decodeCashBytes(address, PREFIX[network])
  if (!b || address !== address.toLowerCase() || !address.startsWith(`${PREFIX[network]}:`))
    return null
  const [version, payload] = [b[0], b.subarray(1)]
  if (version === 0 && payload.length === 32) return Uint8Array.of(0x20, ...payload, 0xac)
  if (version === 1 && payload.length === 33) return Uint8Array.of(0x21, ...payload, 0xab)
  if (version === 8 && payload.length === 32) return Uint8Array.of(0xaa, 0x20, ...payload, 0x87)
  return null
}

/** The address a script pays, if it's one of the three kinds an address can say. */
export function addressOfScript(script: Uint8Array, network: 0 | 1): string | null {
  const s = script
  if (s.length === 34 && s[0] === 0x20 && s[33] === 0xac)
    return encodeCashBytes(PREFIX[network], [0, ...s.subarray(1, 33)])
  if (s.length === 35 && s[0] === 0x21 && s[34] === 0xab)
    return encodeCashBytes(PREFIX[network], [1, ...s.subarray(1, 34)])
  if (s.length === 35 && s[0] === 0xaa && s[1] === 0x20 && s[34] === 0x87)
    return encodeCashBytes(PREFIX[network], [8, ...s.subarray(2, 34)])
  return null
}

/** The account's keys, from what maki shared: its key (33 bytes), then its chain code (32). */
export function accountKeys(account: SharedAccount): HDKey {
  const b = hex.decode(account.publicKey)
  if (b.length !== 65) throw new Error('not a Kaspa account maki shared')
  return new HDKey({ publicKey: b.slice(0, 33), chainCode: b.slice(33) })
}

/** The account's address at `chain` (0 receiving, 1 change) and `index`: its key's, x only. */
export function addressAt(keys: HDKey, network: 0 | 1, chain: 0 | 1, index: number): string {
  const key = keys.deriveChild(chain).deriveChild(index).publicKey!
  return encodeCashBytes(PREFIX[network], [0, ...key.subarray(1)])
}

// ---- a transaction ----

export interface KaspaInput {
  /** the coin: its transaction's ID (as Kaspa shows it) and which output */
  txid: string
  index: number
  amount: bigint
  script: Uint8Array
  /** its key's place in the account */
  chain: 0 | 1
  keyIndex: number
}

export interface KaspaOutput {
  value: bigint
  script: Uint8Array
  /** change: the account's key it pays */
  ours?: { chain: 0 | 1; index: number }
}

export interface KaspaTransaction {
  inputs: KaspaInput[]
  outputs: KaspaOutput[]
}

/** Little-endian bytes, as Kaspa writes its numbers. */
class Bytes {
  private out: number[] = []
  u8(n: number): this {
    this.out.push(n & 0xff)
    return this
  }
  u16(n: number): this {
    return this.u8(n).u8(n >> 8)
  }
  u32(n: number): this {
    return this.u16(n & 0xffff).u16(n >>> 16)
  }
  u64(n: bigint): this {
    for (let i = 0n; i < 8n; i++) this.u8(Number((n >> (8n * i)) & 0xffn))
    return this
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.out.push(b[i])
    return this
  }
  /** bytes after their length, a u64 */
  varBytes(b: ArrayLike<number>): this {
    return this.u64(BigInt(b.length)).bytes(b)
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

/**
 * What maki's Kaspa app takes to sign (maki-kas's `request`): a version 0 transaction, sequence
 * and lock time 0, one signature check for each coin, on the native subnetwork, no payload.
 */
export function request(tx: KaspaTransaction): Uint8Array {
  const w = new Bytes().u16(0).u8(tx.inputs.length)
  for (const i of tx.inputs) {
    w.bytes(hex.decode(i.txid)).u32(i.index).u64(0n).u8(1).u64(i.amount)
    w.u16(0).u8(i.script.length).bytes(i.script)
    w.u8(i.chain).u32(i.keyIndex)
  }
  w.u8(tx.outputs.length)
  for (const o of tx.outputs) {
    w.u64(o.value).u16(0).u8(o.script.length).bytes(o.script)
    if (o.ours) w.u8(1).u8(o.ours.chain).u32(o.ours.index)
    else w.u8(0)
  }
  return w.u64(0n).bytes(new Uint8Array(20)).u64(0n).u16(0).finish()
}

/**
 * A version 0 transaction's ID (rusty-kaspa's `id_v0`): BLAKE2b keyed with "TransactionID", over
 * the transaction without its signature scripts.
 */
export function transactionId(tx: KaspaTransaction): string {
  const w = new Bytes().u16(0).u64(BigInt(tx.inputs.length))
  for (const i of tx.inputs) w.bytes(hex.decode(i.txid)).u32(i.index).varBytes([]).u64(0n)
  w.u64(BigInt(tx.outputs.length))
  for (const o of tx.outputs) w.u64(o.value).u16(0).varBytes(o.script)
  w.u64(0n).bytes(new Uint8Array(20)).u64(0n).varBytes([])
  return hex.encode(
    blake2b(w.finish(), { dkLen: 32, key: new TextEncoder().encode('TransactionID') })
  )
}

/**
 * The transaction's mass, as Kaspa's own wallet weighs it: the greater of its compute mass (its
 * size once signed, its scripts' bytes, its signature checks) and its storage mass (KIP-9: what
 * small outputs cost the network to keep).
 */
export function mass(inputs: bigint[], outputs: KaspaOutput[]): bigint {
  // blank: version, input and output counts, lock time, subnetwork, gas, payload hash and length
  let size = 2n + 8n + 8n + 8n + 20n + 8n + 32n + 8n
  // each input: its coin, its signature script's length and the script (0x41, 64, the type), sequence
  size += BigInt(inputs.length) * (32n + 4n + 8n + 66n + 8n)
  let scriptBytes = 0n
  for (const o of outputs) {
    size += 8n + 2n + 8n + BigInt(o.script.length)
    scriptBytes += 2n + BigInt(o.script.length)
  }
  const compute =
    size * MASS_PER_TX_BYTE +
    scriptBytes * MASS_PER_SCRIPT_PUB_KEY_BYTE +
    BigInt(inputs.length) * MASS_PER_SIG_OP
  // storage (KIP-9): C·Σ 1/output, less the inputs' share (harmonic when it's allowed, else mean)
  let harmonicOut = 0n
  for (const o of outputs) harmonicOut += STORAGE_MASS_PARAMETER / o.value
  let ins: bigint
  if (outputs.length === 1 || inputs.length === 1 || (outputs.length === 2 && inputs.length === 2))
    ins = inputs.reduce((s, v) => s + STORAGE_MASS_PARAMETER / v, 0n)
  else {
    const mean = inputs.reduce((s, v) => s + v, 0n) / BigInt(inputs.length)
    ins = BigInt(inputs.length) * (STORAGE_MASS_PARAMETER / (mean > 0n ? mean : 1n))
  }
  const storage = harmonicOut > ins ? harmonicOut - ins : 0n
  return compute > storage ? compute : storage
}

/** The transaction as api.kaspa.org takes it, each input's signature (65 bytes) in its script. */
export function submission(tx: KaspaTransaction, signatures: Uint8Array): string {
  // amounts can be more than JavaScript's numbers hold exactly: written as they are
  const inputs = tx.inputs.map(
    (i, n) =>
      `{"previousOutpoint":{"transactionId":"${i.txid}","index":${i.index}},"signatureScript":"41${hex.encode(signatures.subarray(65 * n, 65 * n + 65))}","sequence":0,"sigOpCount":1}`
  )
  const outputs = tx.outputs.map(
    (o) =>
      `{"amount":${o.value},"scriptPublicKey":{"version":0,"scriptPublicKey":"${hex.encode(o.script)}"}}`
  )
  return `{"transaction":{"version":0,"inputs":[${inputs.join(',')}],"outputs":[${outputs.join(',')}],"lockTime":0,"subnetworkId":"${'0'.repeat(40)}"},"allowOrphan":false}`
}

// ---- api.kaspa.org ----

async function call(
  fetch: CoinFetch,
  network: 0 | 1,
  method: 'GET' | 'POST',
  path: string,
  body?: object
): Promise<unknown> {
  const r = await fetch(
    network,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body)
  )
  if (r.status !== 200) throw new Error(`api.kaspa.org answered ${r.status}`)
  return JSON.parse(r.text)
}

/** Which of the account's addresses have been used, by chain; its key for each it looked at. */
interface Scan {
  keys: Map<string, { chain: 0 | 1; index: number }>
  used: string[]
  /** the first change address not used yet */
  nextChange: number
}

async function scan(fetch: CoinFetch, network: 0 | 1, keys: HDKey): Promise<Scan> {
  const found: Scan = { keys: new Map(), used: [], nextChange: 0 }
  for (const chain of [0, 1] as const) {
    const branch = keys.deriveChild(chain)
    for (let start = 0; start < 100_000; start += GAP) {
      const batch = Array.from({ length: GAP }, (_, i) => {
        const index = start + i
        const address = encodeCashBytes(PREFIX[network], [
          0,
          ...branch.deriveChild(index).publicKey!.subarray(1)
        ])
        found.keys.set(address, { chain, index })
        return address
      })
      const said = (await call(fetch, network, 'POST', '/addresses/active', {
        addresses: batch
      })) as { address: string; active: boolean }[]
      const active = new Set(said.filter((a) => a.active).map((a) => a.address))
      batch.forEach((a, i) => {
        if (!active.has(a)) return
        found.used.push(a)
        if (chain === 1) found.nextChange = start + i + 1
      })
      if (active.size === 0) break
    }
  }
  return found
}

interface Coin {
  txid: string
  index: number
  amount: bigint
  script: Uint8Array
  address: string
  daaScore: bigint
  coinbase: boolean
}

async function coinsOf(fetch: CoinFetch, network: 0 | 1, addresses: string[]): Promise<Coin[]> {
  if (addresses.length === 0) return []
  const r = (await call(fetch, network, 'POST', '/addresses/utxos', { addresses })) as {
    address: string
    outpoint: { transactionId: string; index: number }
    utxoEntry: {
      amount: string
      scriptPublicKey: { scriptPublicKey: string }
      blockDaaScore: string
      isCoinbase: boolean
    }
  }[]
  return r.map((u) => ({
    txid: u.outpoint.transactionId,
    index: u.outpoint.index,
    amount: BigInt(u.utxoEntry.amount),
    script: hex.decode(u.utxoEntry.scriptPublicKey.scriptPublicKey),
    address: u.address,
    daaScore: BigInt(u.utxoEntry.blockDaaScore),
    coinbase: u.utxoEntry.isCoinbase
  }))
}

const kas = (sompi: bigint): string => {
  const whole = sompi / SOMPI
  const frac = (sompi % SOMPI).toString().padStart(8, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

export const KASPA: AccountChain = {
  id: 'kaspa',
  name: 'Kaspa',
  app: KASPA_APP,
  glyph: 'kaspa',
  tint: 'bg-teal/10 text-teal',
  units: ['KAS', 'TKAS'],
  decimals: 8,
  priced: 'KAS',
  networks: ['Kaspa', 'Testnet 10'],
  hint: 'kaspa:…',
  memo: null,
  wallets: 'The account Kaspium, Kaspa NG, Kastle and Ledger make',
  servers:
    'Balances and payments go through api.kaspa.org, the Kaspa community’s, which sees the account’s addresses and this computer’s IP address. Kaspa charges for small outputs to keep them (its storage mass): a payment of less than about 0.2 KAS costs more than it’s worth, or won’t go at all.',
  explorerName: 'the Kaspa explorer',
  explorer: (network, kind, id) =>
    `https://${network === 0 ? 'explorer' : 'explorer-tn10'}.kaspa.org/${kind === 'tx' ? 'txs' : 'addresses'}/${id}`,
  uri: (address) => address,
  valid: (address, network) => scriptOf(address, network) !== null,

  async look(fetch, account): Promise<ChainState> {
    const network = account.network
    const keys = accountKeys(account)
    if (addressAt(keys, network, 0, 0) !== account.address)
      throw new Error('maki’s Kaspa key and its address don’t agree')
    const found = await scan(fetch, network, keys)
    const coins = await coinsOf(fetch, network, found.used)
    const balance = coins.reduce((s, c) => s + c.amount, 0n)
    // history: the receiving address first, then the others used, as many as are worth asking
    const ours = new Set(found.keys.keys())
    const asked = [...new Set([account.address, ...found.used])].slice(0, 6)
    const seen = new Map<string, Activity>()
    for (const address of asked) {
      if (!found.used.includes(address)) continue
      const txs = (await call(
        fetch,
        network,
        'GET',
        `/addresses/${address}/full-transactions?limit=20&resolve_previous_outpoints=light`
      )) as {
        transaction_id: string
        block_time?: number
        is_accepted?: boolean
        inputs?: { previous_outpoint_address?: string; previous_outpoint_amount?: number }[]
        outputs?: { amount: number; script_public_key_address?: string }[]
      }[]
      for (const t of txs) {
        if (seen.has(t.transaction_id)) continue
        let net = 0n
        let from: string | undefined
        let to: string | undefined
        for (const i of t.inputs ?? []) {
          const a = i.previous_outpoint_address
          if (a && ours.has(a)) net -= BigInt(i.previous_outpoint_amount ?? 0)
          else from ??= a
        }
        for (const o of t.outputs ?? []) {
          const a = o.script_public_key_address
          if (a && ours.has(a)) net += BigInt(o.amount)
          else to ??= a
        }
        seen.set(t.transaction_id, {
          id: t.transaction_id,
          kind: net < 0n ? 'Sent' : 'Received',
          amount: net,
          token: null,
          time: t.block_time ? Math.floor(t.block_time / 1000) : null,
          counterparty: net < 0n ? to : from
        })
      }
    }
    const activity = [...seen.values()]
      .sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity))
      .slice(0, 20)
    const notes: string[] = []
    if (network === 1)
      notes.push(
        'Kaspa’s test network has the same keys and addresses as Kaspa itself, and a signature doesn’t say which network it’s for: maki marks every payment on it as the test network’s.'
      )
    if (coins.length > MAX_INPUTS)
      notes.push(
        `It’s in ${coins.length} coins; a payment spends ${MAX_INPUTS} at most, the most a message to maki holds. To send more at once, send some to yourself first: it gathers them.`
      )
    return {
      holdings: [{ token: null, amount: balance }],
      activity,
      reserved: 0n,
      exists: true,
      notes
    }
  },

  async pay(fetch, account, _state, to, amount) {
    const network = account.network
    const keys = accountKeys(account)
    const payTo = scriptOf(to, network)
    if (!payTo) throw new Error('that isn’t a Kaspa address')
    const [found, fees, dag] = await Promise.all([
      scan(fetch, network, keys),
      call(fetch, network, 'GET', '/info/fee-estimate') as Promise<{
        normalBuckets?: { feerate?: number }[]
        priorityBucket?: { feerate?: number }
      }>,
      call(fetch, network, 'GET', '/info/blockdag') as Promise<{ virtualDaaScore?: string }>
    ])
    const now = BigInt(dag.virtualDaaScore ?? 0)
    const feerate = BigInt(
      Math.max(
        MIN_FEERATE,
        Math.ceil(fees.normalBuckets?.[0]?.feerate ?? fees.priorityBucket?.feerate ?? 0)
      )
    )
    // the account's coins it can spend, the largest first, each with its key's place
    const coins = (await coinsOf(fetch, network, found.used))
      .filter((c) => !c.coinbase || c.daaScore + COINBASE_MATURITY <= now)
      .flatMap((c) => {
        const key = found.keys.get(c.address)
        const script = scriptOf(c.address, network)
        return key && script && hex.encode(script) === hex.encode(c.script) ? [{ ...c, key }] : []
      })
      .sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0))
    const changeKey = { chain: 1 as const, index: found.nextChange }
    const changeScript = scriptOf(addressAt(keys, network, 1, found.nextChange), network)!
    const payment = { value: amount, script: payTo }
    for (let n = 1; n <= Math.min(MAX_INPUTS, coins.length); n++) {
      const spent = coins.slice(0, n)
      const amounts = spent.map((c) => c.amount)
      const total = amounts.reduce((s, v) => s + v, 0n)
      // with no change: what's left over goes to the fee
      const aloneMass = mass(amounts, [payment])
      const aloneFee = aloneMass * feerate
      if (total < amount + aloneFee) continue
      // with change: its own mass, which a smaller change makes greater, worked out until it settles
      let change = total - amount - aloneFee
      let withFee = aloneFee
      let withMass = aloneMass
      for (let k = 0; k < 6 && change > 0n; k++) {
        withMass = mass(amounts, [payment, { value: change, script: changeScript }])
        withFee = withMass * feerate
        change = total - amount - withFee
      }
      const keep = change > 0n && withMass <= MAX_MASS && withFee < aloneFee + change
      if (!keep && aloneMass > MAX_MASS) {
        if (n < Math.min(MAX_INPUTS, coins.length)) continue
        throw new Error(
          amount < 20_000_000n
            ? 'Kaspa won’t take a payment this small (its storage mass): send at least 0.2 KAS'
            : 'it’s too much for one Kaspa transaction: send it in parts'
        )
      }
      const tx: KaspaTransaction = {
        inputs: spent.map((c) => ({
          txid: c.txid,
          index: c.index,
          amount: c.amount,
          script: c.script,
          chain: c.key.chain,
          keyIndex: c.key.index
        })),
        outputs: keep
          ? [payment, { value: change, script: changeScript, ours: changeKey }]
          : [payment]
      }
      // a leftover too big to give away: change that can't be kept is small, or something's amiss
      if (!keep && total - amount - aloneFee > 20_000_000n)
        throw new Error('Kaspa won’t take this payment with its change: send a different amount')
      const fee = keep ? withFee : total - amount
      const notes: string[] = []
      if (!keep && total - amount > aloneFee)
        notes.push(
          `The ${kas(total - amount - aloneFee)} KAS left over is too little to keep as change (Kaspa charges for small outputs): it goes with the fee.`
        )
      return { payload: request(tx), fee, feeIsMost: false, notes, carry: tx }
    }
    throw new Error(
      coins.length > MAX_INPUTS
        ? `that takes more than the ${MAX_INPUTS} largest coins: send less, or gather them first by sending to yourself`
        : 'not enough KAS for that and the fee'
    )
  },

  async submit(fetch, account, payment, signature) {
    const tx = payment.carry as KaspaTransaction
    if (signature.length !== 65 * tx.inputs.length)
      throw new Error('maki’s Kaspa app gave signatures maki desktop can’t read')
    const r = await fetch(account.network, 'POST', '/transactions', submission(tx, signature))
    let body: { transactionId?: string; error?: string; detail?: unknown }
    try {
      body = JSON.parse(r.text)
    } catch {
      throw new Error(`api.kaspa.org answered ${r.status}`)
    }
    if (r.status !== 200 || !body.transactionId)
      throw new Error(
        `the network turned it down: ${body.error ?? (body.detail ? JSON.stringify(body.detail) : r.status)}`
      )
    if (body.transactionId !== transactionId(tx))
      throw new Error('api.kaspa.org took a different transaction from the one maki signed')
    return body.transactionId
  }
}
