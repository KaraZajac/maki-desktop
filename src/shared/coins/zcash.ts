/**
 * Zcash, transparent, for maki desktop's wallet: the account maki's Zcash app shares (its key and
 * chain code at m/44'/133'/0', as Ledger's Zcash app, Zashi and zcashd make transparent keys: every
 * t-address it will have, receiving `/0/i` and change `/1/i`), the addresses it has used and their
 * coins, found through zecblock, and payments made as the app takes them to sign (maki-zec's
 * `request`: a version 5 transaction at the consensus branch in force, each coin it spends with what
 * it holds, its script and its key, and how each output is to be shown), priced by ZIP-317, then
 * sent with each input's signature and key in its script.
 *
 * zecblock lists a transaction once it's in a block, and a coin as spent once what spends it is: a
 * payment sent from here is remembered here until a block has it (or it expires, or the network
 * drops it), its coins not offered again meanwhile. A payment coming in shows once it's mined.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32m, createBase58check, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import type { AccountChain, Activity, ChainState } from '../account-chain'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import { units } from '../tokens'
import { ZCASH_APP } from '../wallet-apps'

/** Zatoshis in a ZEC. */
export const ZATOSHI = 100_000_000n
/**
 * The consensus branch maki's Zcash app signs for: NU6.3's (maki-zec's `tx::BRANCH_ID`). A
 * transaction commits to it; when Zcash moves to its next upgrade (NU7), maki's app and this both
 * learn the new one, here and nowhere else.
 */
export const BRANCH_ID = 0x37a5165b
/** That upgrade's name, as the owner hears of it. */
export const UPGRADE = 'NU6.3'
const VERSION_5 = 0x80000005
const VERSION_GROUP = 0x26a7270a
/** How many blocks a transaction is good for, as Zcash's wallets make them (librustzcash's). */
const EXPIRY_DELTA = 40
/** ZIP-317: the fee for each logical action, and the fewest actions a transaction pays for. */
export const MARGINAL_FEE = 5_000n
const GRACE_ACTIONS = 2n
/** The most coins a payment spends: what a message to maki holds with two outputs (maki-zec's). */
export const MAX_INPUTS = 49
/** Unused addresses in a row that end a scan (BIP44's gap). */
const GAP = 20
/** How long a payment sent from here is thought to be on its way, though zecblock hasn't seen it yet. */
const SEEN_WITHIN_MS = 120_000

const b58 = createBase58check(sha256)
const hash160 = (b: Uint8Array): Uint8Array => ripemd160(sha256(b))
/** t-addresses' prefixes: a key's hash, a script's; on Zcash and its test network. */
const P2PKH = [Uint8Array.of(0x1c, 0xb8), Uint8Array.of(0x1d, 0x25)]
const P2SH = [Uint8Array.of(0x1c, 0xbd), Uint8Array.of(0x1c, 0xba)]
/** TEX addresses' (ZIP-320) human-readable parts. */
const TEX = ['tex', 'textest']

const p2pkhScript = (hash: Uint8Array): Uint8Array =>
  Uint8Array.of(0x76, 0xa9, 0x14, ...hash, 0x88, 0xac)
const p2shScript = (hash: Uint8Array): Uint8Array => Uint8Array.of(0xa9, 0x14, ...hash, 0x87)

/** A key's t-address: `t1…`, `tm…` on the test network. */
export const keyAddress = (key: Uint8Array, network: 0 | 1): string =>
  b58.encode(Uint8Array.from([...P2PKH[network], ...hash160(key)]))

/**
 * What a payee's address pays on `network`: the output script, and how maki's app is to show it (0
 * by its t-address; 2 as the TEX address it was given, ZIP-320's, which pays a key's hash and takes
 * coins from transparent transactions alone). Null if it isn't one of the network's.
 */
export function payTo(
  address: string,
  network: 0 | 1
): { script: Uint8Array; shown: 0 | 2 } | null {
  if (/^t[1-9A-HJ-NP-Za-km-z]{34}$/.test(address)) {
    let b: Uint8Array
    try {
      b = b58.decode(address)
    } catch {
      return null
    }
    if (b.length !== 22) return null
    const [p, hash] = [b.subarray(0, 2), b.subarray(2)]
    if (p[0] === P2PKH[network][0] && p[1] === P2PKH[network][1])
      return { script: p2pkhScript(hash), shown: 0 }
    if (p[0] === P2SH[network][0] && p[1] === P2SH[network][1])
      return { script: p2shScript(hash), shown: 0 }
    return null
  }
  // a TEX address, all in one case, as bech32m holds it
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return null
  try {
    const d = bech32m.decode(address.toLowerCase() as `${string}1${string}`)
    const hash = bech32m.fromWords(d.words)
    return d.prefix === TEX[network] && hash.length === 20
      ? { script: p2pkhScript(hash), shown: 2 }
      : null
  } catch {
    return null
  }
}

/** The account's keys, from what maki shared: its key (33 bytes), then its chain code (32). */
export function accountKeys(account: SharedAccount): HDKey {
  const b = hex.decode(account.publicKey)
  if (b.length !== 65) throw new Error('not a Zcash account maki shared')
  return new HDKey({ publicKey: b.slice(0, 33), chainCode: b.slice(33) })
}

// ---- a transaction ----

export interface ZecInput {
  /** the coin: its transaction's ID (as explorers show it) and which output */
  txid: string
  vout: number
  value: bigint
  /** the script it pays: its key's hash's */
  script: Uint8Array
  /** its key's place in the account, and the key */
  chain: 0 | 1
  index: number
  key: Uint8Array
}

export interface ZecOutput {
  value: bigint
  script: Uint8Array
  /** a payment by its t-address (0) or TEX address (2); or change, to this key of the account's */
  shown: 0 | 2 | { change: number }
}

export interface ZecTransaction {
  expiry: number
  inputs: ZecInput[]
  outputs: ZecOutput[]
}

/** Little-endian bytes, as Zcash writes its numbers. */
class Bytes {
  readonly out: number[] = []
  u8(n: number): this {
    this.out.push(n & 0xff)
    return this
  }
  u32(n: number): this {
    for (let i = 0; i < 4; i++) this.out.push((n >>> (8 * i)) & 0xff)
    return this
  }
  u64(n: bigint): this {
    for (let i = 0n; i < 8n; i++) this.out.push(Number((n >> (8n * i)) & 0xffn))
    return this
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.out.push(b[i])
    return this
  }
  /** CompactSize, in its shortest form */
  compact(n: number): this {
    if (n < 0xfd) return this.u8(n)
    if (n <= 0xffff)
      return this.u8(0xfd)
        .u8(n)
        .u8(n >> 8)
    return this.u8(0xfe).u32(n)
  }
  /** bytes after their CompactSize length */
  script(b: Uint8Array): this {
    return this.compact(b.length).bytes(b)
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

/** A coin's outpoint as transactions write it: its txid's bytes (reversed from how it's shown), its index. */
const outpoint = (w: Bytes, i: ZecInput): Bytes => w.bytes(hex.decode(i.txid).reverse()).u32(i.vout)

/**
 * The transaction as Zcash writes it (version 5, ZIP-225), transparent alone: unsigned, or with each
 * input's script. No lock time; every input's sequence final; no Sapling or Orchard parts.
 */
export function transaction(tx: ZecTransaction, scriptSigs: Uint8Array[] = []): Uint8Array {
  const w = new Bytes().u32(VERSION_5).u32(VERSION_GROUP).u32(BRANCH_ID).u32(0).u32(tx.expiry)
  w.compact(tx.inputs.length)
  tx.inputs.forEach((i, n) =>
    outpoint(w, i)
      .script(scriptSigs[n] ?? new Uint8Array())
      .u32(0xffffffff)
  )
  w.compact(tx.outputs.length)
  for (const o of tx.outputs) w.u64(o.value).script(o.script)
  return w.u8(0).u8(0).u8(0).finish()
}

/**
 * What maki's Zcash app takes to sign (maki-zec's `request`): the transaction, unsigned, after its
 * length; each coin it spends (what it holds, its script, its key's place); how each output is shown.
 */
export function request(tx: ZecTransaction): Uint8Array {
  const t = transaction(tx)
  const w = new Bytes()
    .u8(t.length)
    .u8(t.length >> 8)
    .bytes(t)
  for (const i of tx.inputs)
    w.u64(i.value).u8(i.script.length).bytes(i.script).u8(i.chain).u32(i.index)
  for (const o of tx.outputs) {
    if (typeof o.shown === 'number') w.u8(o.shown)
    else w.u8(1).u8(1).u32(o.shown.change)
  }
  return w.finish()
}

/**
 * ZIP-317's fee for a transaction of this wallet's coins: each input pays a key's hash and counts as
 * one action; the outputs count by their size, 34 bytes an action; two actions at least.
 */
export function conventionalFee(inputs: number, outputs: Uint8Array[]): bigint {
  const bytes = outputs.reduce((n, s) => n + 8 + (s.length < 0xfd ? 1 : 3) + s.length, 0)
  const actions = BigInt(Math.max(inputs, Math.ceil(bytes / 34)))
  return MARGINAL_FEE * (actions > GRACE_ACTIONS ? actions : GRACE_ACTIONS)
}

// ZIP-244's digests: BLAKE2b-256, each personalized with what it hashes

const personal = (name: string): Uint8Array => new TextEncoder().encode(name)
const h = (name: string | Uint8Array, data: Uint8Array): Uint8Array =>
  blake2b(data, { dkLen: 32, personalization: typeof name === 'string' ? personal(name) : name })
const cat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]))

function digests(tx: ZecTransaction) {
  const header = h(
    'ZTxIdHeadersHash',
    new Bytes().u32(VERSION_5).u32(VERSION_GROUP).u32(BRANCH_ID).u32(0).u32(tx.expiry).finish()
  )
  const prevouts = new Bytes()
  for (const i of tx.inputs) outpoint(prevouts, i)
  const sequences = new Bytes()
  for (let n = 0; n < tx.inputs.length; n++) sequences.u32(0xffffffff)
  const outputs = new Bytes()
  for (const o of tx.outputs) outputs.u64(o.value).script(o.script)
  const root = cat(personal('ZcashTxHash_'), new Bytes().u32(BRANCH_ID).finish())
  return {
    header,
    prevouts: h('ZTxIdPrevoutHash', prevouts.finish()),
    sequences: h('ZTxIdSequencHash', sequences.finish()),
    outputs: h('ZTxIdOutputsHash', outputs.finish()),
    sapling: h('ZTxIdSaplingHash', new Uint8Array()),
    orchard: h('ZTxIdOrchardHash', new Uint8Array()),
    root
  }
}

/** The transaction's ID (ZIP-244's), as explorers show it. Signing doesn't change it. */
export function transactionId(tx: ZecTransaction): string {
  const d = digests(tx)
  const transparent = h('ZTxIdTranspaHash', cat(d.prevouts, d.sequences, d.outputs))
  return hex.encode(h(d.root, cat(d.header, transparent, d.sapling, d.orchard)).reverse())
}

/** What input `n`'s signature signs (ZIP-244, SIGHASH_ALL): every coin's amount and script among it. */
export function signatureHash(tx: ZecTransaction, n: number): Uint8Array {
  const d = digests(tx)
  const amounts = new Bytes()
  const scripts = new Bytes()
  for (const i of tx.inputs) {
    amounts.u64(i.value)
    scripts.script(i.script)
  }
  const me = tx.inputs[n]
  const txin = h(
    'Zcash___TxInHash',
    outpoint(new Bytes(), me).u64(me.value).script(me.script).u32(0xffffffff).finish()
  )
  const transparent = h(
    'ZTxIdTranspaHash',
    cat(
      Uint8Array.of(1),
      d.prevouts,
      h('ZTxTrAmountsHash', amounts.finish()),
      h('ZTxTrScriptsHash', scripts.finish()),
      d.sequences,
      d.outputs,
      txin
    )
  )
  return h(d.root, cat(d.header, transparent, d.sapling, d.orchard))
}

/**
 * maki's answer to a request: each input's signature as its script pushes it (DER, then SIGHASH_ALL's
 * byte), after its length. Null if it isn't that, for each input.
 */
export function readSignatures(answer: Uint8Array, inputs: number): Uint8Array[] | null {
  const out: Uint8Array[] = []
  let at = 0
  while (at < answer.length) {
    const n = answer[at]
    if (n < 9 || n > 73 || at + 1 + n > answer.length) return null
    out.push(answer.slice(at + 1, at + 1 + n))
    at += 1 + n
  }
  return out.length === inputs && out.every((s) => s[0] === 0x30 && s[s.length - 1] === 1)
    ? out
    : null
}

// ---- zecblock ----

async function get(
  fetch: CoinFetch,
  network: 0 | 1,
  path: string
): Promise<Record<string, unknown>> {
  const r = await fetch(network, 'GET', path)
  let json: { data?: unknown; detail?: unknown }
  try {
    json = JSON.parse(r.text)
  } catch {
    throw new Error(`zecblock answered ${r.status}`)
  }
  if (r.status !== 200 || typeof json.data !== 'object' || json.data === null)
    throw new Error(
      typeof json.detail === 'string' ? `zecblock: ${json.detail}` : `zecblock answered ${r.status}`
    )
  return json.data as Record<string, unknown>
}

/** Zatoshis as zecblock writes them: decimal text (or a whole number), exactly. */
const zats = (v: unknown): bigint => {
  if (typeof v === 'string' && /^\d{1,17}$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  throw new Error('zecblock sent an amount that isn’t one')
}
const signedZats = (v: unknown): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^-?\d{1,17}$/.test(v)) return BigInt(v)
  throw new Error('zecblock sent an amount that isn’t one')
}
const isTxid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)

/** An address's place in the account, its totals, and its transactions as zecblock lists them. */
interface Seen {
  address: string
  chain: 0 | 1
  index: number
  key: Uint8Array
  balance: bigint
  txs: {
    txid: string
    time: number | null
    net: bigint
    received: boolean
    counterparty?: string
  }[]
}

/** One address, as zecblock has it: its balance, and its last hundred transactions. */
async function seeAddress(
  fetch: CoinFetch,
  network: 0 | 1,
  a: Omit<Seen, 'balance' | 'txs'>
): Promise<Seen> {
  const d = await get(fetch, network, `/v1/addresses/${a.address}?page=1&limit=100`)
  if (d.address !== a.address || !Array.isArray(d.transactions))
    throw new Error('zecblock sent another address')
  return {
    ...a,
    balance: zats(d.balance ?? '0'),
    txs: (d.transactions as Record<string, unknown>[]).map((t) => {
      if (!isTxid(t.txid)) throw new Error('zecblock sent a transaction maki desktop can’t read')
      const time = Number(t.blockTime)
      return {
        txid: t.txid,
        time: Number.isSafeInteger(time) && time > 0 ? time : null,
        net: signedZats(t.netChange ?? 0),
        received: zats(t.outputValue ?? 0) > 0n,
        counterparty: typeof t.counterparty === 'string' ? t.counterparty : undefined
      }
    })
  }
}

/** The account's used addresses, both chains, until GAP unused in a row; and where change goes next. */
async function scan(
  fetch: CoinFetch,
  network: 0 | 1,
  keys: HDKey
): Promise<{ used: Seen[]; nextChange: { index: number; address: string; key: Uint8Array } }> {
  const used: Seen[] = []
  let nextChange = 0
  for (const chain of [0, 1] as const) {
    const branch = keys.deriveChild(chain)
    let unused = 0
    for (let start = 0; unused < GAP; start += 5) {
      const batch = await Promise.all(
        [0, 1, 2, 3, 4].map((k) => {
          const key = branch.deriveChild(start + k).publicKey!
          return seeAddress(fetch, network, {
            address: keyAddress(key, network),
            chain,
            index: start + k,
            key
          })
        })
      )
      for (const s of batch) {
        if (unused >= GAP) break
        if (s.txs.length === 0 && s.balance === 0n) unused++
        else {
          unused = 0
          used.push(s)
          if (chain === 1) nextChange = s.index + 1
        }
      }
    }
  }
  const key = keys.deriveChild(1).deriveChild(nextChange).publicKey!
  return { used, nextChange: { index: nextChange, address: keyAddress(key, network), key } }
}

/** Each account's last scan, by its network and first address: a payment made soon after uses it. */
const scanned = new Map<string, { at: number; found: Awaited<ReturnType<typeof scan>> }>()
/** How long a scan is used again for: zecblock's view moves a block at a time. */
const SCAN_FOR_MS = 120_000

async function scanOf(
  fetch: CoinFetch,
  account: SharedAccount,
  keys: HDKey,
  fresh: boolean
): Promise<Awaited<ReturnType<typeof scan>>> {
  const key = `${account.network} ${account.address}`
  const kept = scanned.get(key)
  if (!fresh && kept && Date.now() - kept.at < SCAN_FOR_MS) return kept.found
  const found = await scan(fetch, account.network, keys)
  scanned.set(key, { at: Date.now(), found })
  return found
}

/** A coin of the account's, unspent as zecblock says (what's in a block alone). */
type Coin = ZecInput

/** The coins at each used address with a balance: its transactions' outputs to it not yet spent. */
async function coinsOf(
  fetch: CoinFetch,
  network: 0 | 1,
  used: Seen[]
): Promise<{ coins: Coin[]; short: bigint }> {
  const outputs = new Map<
    string,
    { address: string | null; value: bigint; vout: number; spent: boolean }[]
  >()
  const coins: Coin[] = []
  let short = 0n
  for (const s of used) {
    if (s.balance === 0n) continue
    let found = 0n
    for (const t of s.txs) {
      if (found >= s.balance) break
      if (!t.received) continue
      let outs = outputs.get(t.txid)
      if (!outs) {
        const d = await get(fetch, network, `/v1/transactions/${t.txid}`)
        if (d.txid !== t.txid || !Array.isArray(d.outputs))
          throw new Error('zecblock sent another transaction')
        outs = (d.outputs as Record<string, unknown>[]).map((o) => ({
          address: typeof o.address === 'string' ? o.address : null,
          value: zats(o.value),
          vout: Number(o.vout_index),
          spent: o.spent === true
        }))
        outputs.set(t.txid, outs)
      }
      for (const o of outs) {
        if (o.address !== s.address || o.spent || !Number.isSafeInteger(o.vout) || o.vout < 0)
          continue
        coins.push({
          txid: t.txid,
          vout: o.vout,
          value: o.value,
          script: p2pkhScript(hash160(s.key)),
          chain: s.chain,
          index: s.index,
          key: s.key
        })
        found += o.value
      }
    }
    // more coins than its last hundred transactions show: not looked for further
    if (found < s.balance) short += s.balance - found
  }
  return { coins, short }
}

/** A payment sent from here, until a block has it: the coins it spends, its change, what it sent. */
interface Pending {
  txid: string
  spends: string[]
  change: { vout: number; value: bigint } | null
  /** what left the account: sent, and the fee */
  out: bigint
  to: string
  at: number
}
/** Each account's payments on their way, by its network and first address. */
const pending = new Map<string, Pending[]>()
const pendingKey = (account: SharedAccount): string => `${account.network} ${account.address}`

/** The account's payments still on their way: those a block has, or the network has dropped, go. */
async function stillPending(
  fetch: CoinFetch,
  account: SharedAccount,
  mined: Set<string>
): Promise<Pending[]> {
  const still: Pending[] = []
  for (const p of pending.get(pendingKey(account)) ?? []) {
    if (mined.has(p.txid)) continue
    if (Date.now() - p.at > SEEN_WITHIN_MS) {
      const d = await get(fetch, account.network, `/v1/mempool/${p.txid}`)
      if (d.inMempool !== true) continue
    }
    still.push(p)
  }
  pending.set(pendingKey(account), still)
  return still
}

const zec = (z: bigint, network: 0 | 1): string => `${units(z, 8)} ${network === 0 ? 'ZEC' : 'TAZ'}`

/** The network's tip, and the expiry height a transaction made now gets; refused if maki's app can't sign for what's in force. */
async function chainNow(
  fetch: CoinFetch,
  network: 0 | 1
): Promise<{ tip: number; expiry: number }> {
  const d = await get(fetch, network, '/v1/network/blockchain-info')
  const tip = Number(d.blocks)
  const consensus = d.consensus as { chaintip?: unknown; nextblock?: unknown } | undefined
  const upgrades = (d.upgrades ?? {}) as Record<
    string,
    { name?: unknown; activationheight?: unknown; status?: unknown }
  >
  if (!Number.isSafeInteger(tip) || tip <= 0 || typeof consensus?.nextblock !== 'string')
    throw new Error('zecblock sent the chain’s state in a form maki desktop can’t read')
  const ours = BRANCH_ID.toString(16).padStart(8, '0')
  if (consensus.nextblock !== ours) {
    const name = upgrades[consensus.nextblock]?.name
    throw new Error(
      `Zcash’s next block follows ${typeof name === 'string' ? name : 'a network upgrade'}’s rules, and maki’s Zcash app signs for ${UPGRADE}’s: it needs an update before it can send`
    )
  }
  // good for 40 blocks after the next, but never past the next upgrade's start, where it couldn't be mined
  let expiry = tip + 1 + EXPIRY_DELTA
  for (const u of Object.values(upgrades)) {
    const at = Number(u.activationheight)
    if (u.status === 'pending' && Number.isSafeInteger(at) && at > tip)
      expiry = Math.min(expiry, at - 1)
  }
  if (expiry <= tip + 1)
    throw new Error(
      'Zcash changes its rules at the next block: wait for it, and for maki’s Zcash app to learn the new ones'
    )
  return { tip, expiry }
}

export const ZCASH: AccountChain = {
  id: 'zcash',
  name: 'Zcash',
  app: ZCASH_APP,
  glyph: 'zcash',
  tint: 'bg-yellow/10 text-yellow',
  units: ['ZEC', 'TAZ'],
  decimals: 8,
  priced: 'ZEC',
  networks: ['Zcash', 'Testnet'],
  hint: 't1… or tex1…',
  memo: null,
  wallets: 'The transparent account Ledger, Zashi and zcashd make',
  servers:
    'Balances and payments go through zecblock.com, which sees the account’s t-addresses and this computer’s IP address. Transparent alone: maki can’t see into shielded transactions, and refuses them. zecblock shows a payment once it’s in a block (a minute and a quarter, or so): one coming in shows then, and one sent from here is kept in mind here until it is.',
  explorerName: 'zecblock.com',
  explorer: (network, kind, id) =>
    `https://${network === 1 ? 'testnet.' : ''}zecblock.com/${kind === 'tx' ? 'tx' : 'address'}/${id}`,
  uri: (address) => `zcash:${address}`,
  valid: (address, network) => payTo(address, network) !== null,

  async look(fetch, account): Promise<ChainState> {
    const network = account.network
    const keys = accountKeys(account)
    if (keyAddress(keys.deriveChild(0).deriveChild(0).publicKey!, network) !== account.address)
      throw new Error('maki’s Zcash key and its address don’t agree')
    const { used } = await scanOf(fetch, account, keys, true)
    const mined = new Set(used.flatMap((s) => s.txs.map((t) => t.txid)))
    const waiting = await stillPending(fetch, account, mined)
    let balance = used.reduce((n, s) => n + s.balance, 0n)
    for (const p of waiting) balance -= p.out
    // history: each transaction once, what it did to the account in all
    const ours = new Set(used.map((s) => s.address))
    const byTx = new Map<string, Activity>()
    for (const s of used)
      for (const t of s.txs) {
        const a = byTx.get(t.txid)
        const other = t.counterparty && !ours.has(t.counterparty) ? t.counterparty : undefined
        if (a) {
          a.amount = (a.amount ?? 0n) + t.net
          a.counterparty ??= other
        } else
          byTx.set(t.txid, {
            id: t.txid,
            kind: '',
            amount: t.net,
            token: null,
            time: t.time,
            counterparty: other
          })
      }
    const activity: Activity[] = [
      ...waiting.map((p) => ({
        id: p.txid,
        kind: 'Sent',
        amount: -p.out,
        token: null,
        time: null,
        counterparty: p.to
      })),
      ...[...byTx.values()]
        .map((a) => ({
          ...a,
          kind: (a.amount ?? 0n) < 0n ? 'Sent' : (a.amount ?? 0n) > 0n ? 'Received' : 'Moved'
        }))
        .sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity))
    ].slice(0, 20)
    const notes: string[] = []
    if (waiting.length)
      notes.push(
        `${waiting.length === 1 ? 'A payment' : `${waiting.length} payments`} sent from here ${waiting.length === 1 ? 'waits' : 'wait'} for a block: what ${waiting.length === 1 ? 'it spends is' : 'they spend is'} counted out already, and ${waiting.length === 1 ? 'its' : 'their'} change comes back once zecblock sees it in one.`
      )
    if (network === 1) notes.push('Zcash’s test network: its coins (TAZ) are worth nothing.')
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
    const payee = payTo(to, network)
    if (!payee) throw new Error('that isn’t a Zcash t-address')
    const { expiry } = await chainNow(fetch, network)
    // the account as the last look found it (a block a minute and a quarter: little changes)
    const { used, nextChange } = await scanOf(fetch, account, keys, false)
    const mined = new Set(used.flatMap((s) => s.txs.map((t) => t.txid)))
    const waiting = await stillPending(fetch, account, mined)
    const spoken = new Set(waiting.flatMap((p) => p.spends))
    const { coins: all, short } = await coinsOf(fetch, network, used)
    // the coins a block has, not spent by a payment on its way; the largest first
    const coins = all
      .filter((c) => !spoken.has(`${c.txid}:${c.vout}`))
      .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0))
    const changeScript = p2pkhScript(hash160(nextChange.key))
    for (let n = 1; n <= Math.min(MAX_INPUTS, coins.length); n++) {
      const spent = coins.slice(0, n)
      const total = spent.reduce((s, c) => s + c.value, 0n)
      const alone = conventionalFee(n, [payee.script])
      if (total < amount + alone) continue
      const withChange = conventionalFee(n, [payee.script, changeScript])
      const change = total - amount - withChange
      // change worth less than the fee for an action goes with the fee
      const keep = change >= MARGINAL_FEE
      const fee = keep ? withChange : total - amount
      const tx: ZecTransaction = {
        expiry,
        inputs: spent.map((c) => ({ ...c })),
        outputs: [
          { value: amount, script: payee.script, shown: payee.shown },
          ...(keep
            ? [{ value: change, script: changeScript, shown: { change: nextChange.index } }]
            : [])
        ]
      }
      const payload = request(tx)
      if (payload.length > 4094)
        throw new Error('that’s more coins than maki takes at once: send less')
      const notes = [
        keep
          ? `Its fee is ZIP-317’s, ${zec(fee, network)}; the change goes to the account’s change address #${nextChange.index}.`
          : `Its fee is ${zec(fee, network)}: ZIP-317’s, and the ${zec(total - amount - alone, network)} left over, too little to be worth an output.`
      ]
      if (short > 0n)
        notes.push(
          `zecblock lists only each address’s last hundred transactions: ${zec(short, network)} of the account’s coins weren’t found among them, and aren’t spent.`
        )
      return {
        payload,
        fee,
        feeIsMost: true,
        notes,
        carry: { tx, change: keep ? nextChange.address : null, to }
      }
    }
    throw new Error(
      coins.length > MAX_INPUTS
        ? `that takes more than the ${MAX_INPUTS} largest coins: send less, or gather them first by sending to yourself`
        : `not enough ${network === 0 ? 'ZEC' : 'TAZ'} for that and the fee${waiting.length ? ' (a payment on its way has some of it)' : ''}`
    )
  },

  async submit(fetch, account, payment, signature) {
    const { tx, change, to } = payment.carry as {
      tx: ZecTransaction
      change: string | null
      to: string
    }
    const sigs = readSignatures(signature, tx.inputs.length)
    if (!sigs) throw new Error('maki’s Zcash app gave signatures maki desktop can’t read')
    // each checked here first: zecblock says only that it couldn't send a bad one
    sigs.forEach((s, n) => {
      if (
        !secp256k1.verify(s.subarray(0, -1), signatureHash(tx, n), tx.inputs[n].key, {
          prehash: false,
          format: 'der'
        })
      )
        throw new Error(`maki’s signature for coin ${n + 1} doesn’t check out`)
    })
    const signed = transaction(
      tx,
      sigs.map((s, n) => Uint8Array.of(s.length, ...s, 0x21, ...tx.inputs[n].key))
    )
    const id = transactionId(tx)
    const r = await fetch(
      account.network,
      'POST',
      '/v1/transactions/broadcast',
      JSON.stringify({ rawTx: hex.encode(signed) })
    )
    let body: { data?: unknown; detail?: unknown }
    try {
      body = JSON.parse(r.text)
    } catch {
      throw new Error(`zecblock answered ${r.status}`)
    }
    if (r.status !== 200)
      throw new Error(
        `zecblock didn’t send it: ${typeof body.detail === 'string' ? body.detail : `it answered ${r.status}`}`
      )
    const said =
      typeof body.data === 'string'
        ? body.data
        : (body.data as { txid?: unknown } | undefined)?.txid
    if (said !== undefined && said !== id)
      throw new Error('zecblock took a different transaction from the one maki signed')
    const key = pendingKey(account)
    const vout = change ? tx.outputs.length - 1 : -1
    pending.set(key, [
      ...(pending.get(key) ?? []),
      {
        txid: id,
        spends: tx.inputs.map((i) => `${i.txid}:${i.vout}`),
        change: change ? { vout, value: tx.outputs[vout].value } : null,
        out: tx.inputs.reduce((n, i) => n + i.value, 0n) - (change ? tx.outputs[vout].value : 0n),
        to,
        at: Date.now()
      }
    ])
    return id
  }
}
