/**
 * Cardano, for maki desktop's wallet: the account maki's Cardano app shares (Icarus keys at
 * m/1852'/1815'/0', Eternl's, Lace's, Yoroi's and Ledger's: its key and chain code, so every
 * address it will have), its base addresses (a payment key with the account's stake key, CIP-19),
 * what it holds (ADA, and the tokens maki knows), its history, from Koios; and payments made as the
 * app takes them to sign: the keys its coins need, its change, and a Conway transaction body in
 * CIP-21's canonical CBOR, its fee the ledger's for its size; maki's witnesses go in beside the body
 * exactly as it was sent.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { bech32, hex } from '@scure/base'
import type { AccountChain, Activity, ChainToken, Holding } from '../account-chain'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import { CARDANO_APP } from '../wallet-apps'

/** Lovelace in an ADA. */
export const LOVELACE = 1_000_000n
/** How long a payment stays good for, in slots (seconds): room to go through it on maki. */
const VALID_FOR = 7200n
/** The most coins one payment spends: the keys they need must come back in one answer. */
const MAX_INPUTS = 40

/** Tokens maki knows (maki-ada's `tokens`), by policy and name (hex), on Cardano's own network. */
const KNOWN: { policy: string; name: string; symbol: string; decimals: number }[] = [
  {
    policy: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
    name: '0014df105553444d',
    symbol: 'USDM',
    decimals: 6
  },
  {
    policy: '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61',
    name: hex.encode(new TextEncoder().encode('DjedMicroUSD')),
    symbol: 'DJED',
    decimals: 6
  },
  {
    policy: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880',
    name: hex.encode(new TextEncoder().encode('iUSD')),
    symbol: 'iUSD',
    decimals: 6
  },
  {
    policy: 'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456',
    name: hex.encode(new TextEncoder().encode('USDA')),
    symbol: 'USDA',
    decimals: 6
  },
  {
    policy: '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6',
    name: hex.encode(new TextEncoder().encode('MIN')),
    symbol: 'MIN',
    decimals: 6
  },
  {
    policy: '533bb94a8850ee3ccbe483106489399112b74c905342cb1792a797a0',
    name: hex.encode(new TextEncoder().encode('INDY')),
    symbol: 'INDY',
    decimals: 6
  },
  {
    policy: '1d7f33bd23d85e1a25d87d86fac4f199c3197a2f7afeb662a0f34e1e',
    name: hex.encode(new TextEncoder().encode('worldmobiletoken')),
    symbol: 'WMT',
    decimals: 6
  },
  {
    policy: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f',
    name: hex.encode(new TextEncoder().encode('SNEK')),
    symbol: 'SNEK',
    decimals: 0
  },
  {
    policy: 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235',
    name: hex.encode(new TextEncoder().encode('HOSKY')),
    symbol: 'HOSKY',
    decimals: 0
  }
]

function tokenOf(network: 0 | 1, unit: string): ChainToken | null {
  const k = network === 0 ? KNOWN.find((k) => k.policy + k.name === unit) : undefined
  return k ? { id: unit, symbol: k.symbol, decimals: k.decimals } : null
}

// ---- keys and addresses ----

/** A public key with its chain code: BIP32-Ed25519's (Icarus's), which derives its soft children. */
export interface XPub {
  key: Uint8Array
  chainCode: Uint8Array
}

/** The soft child at `index` (V2 derivation): the key moved by 8·ZL times the base point. */
export function child(x: XPub, index: number): XPub {
  const i = Uint8Array.of(index & 0xff, (index >>> 8) & 0xff, (index >>> 16) & 0xff, index >>> 24)
  const z = hmac(sha512, x.chainCode, Uint8Array.from([0x02, ...x.key, ...i]))
  const zl = z.subarray(0, 28).reduceRight((v, b) => (v << 8n) | BigInt(b), 0n) * 8n
  const key = ed25519.Point.fromBytes(x.key).add(ed25519.Point.BASE.multiply(zl)).toBytes()
  const chainCode = hmac(sha512, x.chainCode, Uint8Array.from([0x03, ...x.key, ...i])).subarray(32)
  return { key, chainCode }
}

/** The account's key and chain code, as maki shared them (64 bytes). */
export function accountKey(account: SharedAccount): XPub {
  const b = hex.decode(account.publicKey)
  if (b.length !== 64) throw new Error('not a Cardano account maki shared')
  return { key: b.subarray(0, 32), chainCode: b.subarray(32) }
}

const keyHash = (key: Uint8Array): Uint8Array => blake2b(key, { dkLen: 28 })
const PREFIX = { address: ['addr', 'addr_test'], stake: ['stake', 'stake_test'] }

/** The account's keys, worked out once each. */
export class Keys {
  private memo = new Map<string, Uint8Array>()
  readonly stake: Uint8Array
  constructor(private account: XPub) {
    this.stake = this.key(2, 0)
  }
  /** The key at `role` (0 receiving, 1 change, 2 staking) and `index`. */
  key(role: 0 | 1 | 2, index: number): Uint8Array {
    const id = `${role}/${index}`
    let k = this.memo.get(id)
    if (!k) {
      k = child(child(this.account, role), index).key
      this.memo.set(id, k)
    }
    return k
  }
  /** A base address's bytes: the payment key's hash, then the stake key's. */
  baseBytes(network: 0 | 1, role: 0 | 1, index: number): Uint8Array {
    return Uint8Array.from([
      network === 0 ? 0x01 : 0x00,
      ...keyHash(this.key(role, index)),
      ...keyHash(this.stake)
    ])
  }
  address(network: 0 | 1, role: 0 | 1, index: number): string {
    return bech32.encode(
      PREFIX.address[network],
      bech32.toWords(this.baseBytes(network, role, index)),
      200
    )
  }
  /** The stake key's reward address, which Koios knows the account by. */
  reward(network: 0 | 1): string {
    return bech32.encode(
      PREFIX.stake[network],
      bech32.toWords(Uint8Array.from([network === 0 ? 0xe1 : 0xe0, ...keyHash(this.stake)])),
      200
    )
  }
}

/**
 * An address's bytes, if it's a Shelley payment address on `network` maki desktop pays: a base
 * address or an enterprise one (keys or scripts). Byron's and pointers aren't taken.
 */
export function addressBytes(address: string, network: 0 | 1): Uint8Array | null {
  try {
    const { prefix, words } = bech32.decode(address as `${string}1${string}`, 200)
    if (prefix !== PREFIX.address[network]) return null
    const b = bech32.fromWords(words)
    const kind = b[0] >> 4
    if ((b[0] & 0x0f) !== (network === 0 ? 1 : 0)) return null
    if (kind <= 3) return b.length === 57 ? b : null
    if (kind === 6 || kind === 7) return b.length === 29 ? b : null
    return null
  } catch {
    return null
  }
}

// ---- CBOR, canonical (CIP-21) ----

/** A canonical CBOR writer: smallest heads, definite lengths, map keys sorted as CIP-21 sorts them. */
class Cbor {
  private out: number[] = []
  private head(major: number, n: bigint | number): this {
    const v = BigInt(n)
    const m = major << 5
    if (v < 24n) this.out.push(m | Number(v))
    else if (v < 0x100n) this.out.push(m | 24, Number(v))
    else if (v < 0x10000n) this.out.push(m | 25, Number(v >> 8n), Number(v & 0xffn))
    else if (v < 0x100000000n)
      this.out.push(m | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn)))
    else
      this.out.push(
        m | 27,
        ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn))
      )
    return this
  }
  uint(n: bigint | number): this {
    return this.head(0, n)
  }
  bytes(b: Uint8Array): this {
    this.head(2, b.length)
    for (const x of b) this.out.push(x)
    return this
  }
  array(n: number): this {
    return this.head(4, n)
  }
  map(n: number): this {
    return this.head(5, n)
  }
  /** a set, as Conway tags one (258), then its array's head */
  set(n: number): this {
    return this.head(6, 258).array(n)
  }
  raw(b: Uint8Array): this {
    for (const x of b) this.out.push(x)
    return this
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

/** CIP-21's order for map keys: the shorter encoding first, then byte by byte. */
const canonical = (a: Uint8Array, b: Uint8Array): number => {
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** Tokens, by unit (policy then name, hex): what an output carries besides its ADA. */
type Assets = Map<string, bigint>

/** An output's value: its lovelace, then its tokens by policy and name, canonically. */
function value(w: Cbor, lovelace: bigint, assets: Assets): void {
  const held = [...assets.entries()].filter(([, q]) => q > 0n)
  if (held.length === 0) {
    w.uint(lovelace)
    return
  }
  w.array(2).uint(lovelace)
  const policies = new Map<string, [Uint8Array, bigint][]>()
  for (const [unit, q] of held) {
    const list = policies.get(unit.slice(0, 56)) ?? []
    list.push([hex.decode(unit.slice(56)), q])
    policies.set(unit.slice(0, 56), list)
  }
  const keyed = [...policies.entries()].map(([p, names]) => ({
    key: new Cbor().bytes(hex.decode(p)).finish(),
    names: names
      .map(([n, q]) => ({ key: new Cbor().bytes(n).finish(), q }))
      .sort((a, b) => canonical(a.key, b.key))
  }))
  keyed.sort((a, b) => canonical(a.key, b.key))
  w.map(keyed.length)
  for (const p of keyed) {
    w.raw(p.key).map(p.names.length)
    for (const n of p.names) w.raw(n.key).uint(n.q)
  }
}

export interface CardanoInput {
  txid: string
  index: number
  lovelace: bigint
  assets: Assets
  /** the payment key it needs */
  role: 0 | 1
  keyIndex: number
}

export interface CardanoOutput {
  address: Uint8Array
  lovelace: bigint
  assets: Assets
  /** change: the payment key it pays (with the account's stake key) */
  change?: { role: 0 | 1; index: number }
}

/** One output, as the body holds it: its address and its value (the array form). */
function output(o: CardanoOutput): Uint8Array {
  const w = new Cbor().array(2).bytes(o.address)
  value(w, o.lovelace, o.assets)
  return w.finish()
}

/** The body: inputs (a set, sorted, tagged as CSL tags it), outputs, the fee and the slot it's good until. */
export function body(
  inputs: CardanoInput[],
  outputs: CardanoOutput[],
  fee: bigint,
  ttl: bigint
): Uint8Array {
  const sorted = [...inputs].sort((a, b) =>
    a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.index - b.index
  )
  const w = new Cbor().map(4).uint(0).set(sorted.length)
  for (const i of sorted) w.array(2).bytes(hex.decode(i.txid)).uint(i.index)
  w.uint(1).array(outputs.length)
  for (const o of outputs) w.raw(output(o))
  return w.uint(2).uint(fee).uint(3).uint(ttl).finish()
}

/** The signed transaction: the body as it was, its key witnesses, valid, no metadata. */
export function transaction(
  bodyBytes: Uint8Array,
  witnesses: [Uint8Array, Uint8Array][]
): Uint8Array {
  const w = new Cbor().array(4).raw(bodyBytes).map(1).uint(0).set(witnesses.length)
  for (const [key, sig] of witnesses) w.array(2).bytes(key).bytes(sig)
  return w.raw(Uint8Array.of(0xf5, 0xf6)).finish()
}

/** A transaction's ID: BLAKE2b-256 of its body. */
export const transactionId = (bodyBytes: Uint8Array): string =>
  hex.encode(blake2b(bodyBytes, { dkLen: 32 }))

/** What maki's Cardano app takes (maki-ada's `request`): the keys, the change, the body. */
export function request(
  keys: { role: 0 | 1; index: number }[],
  outputs: CardanoOutput[],
  bodyBytes: Uint8Array
): Uint8Array {
  const out: number[] = [keys.length]
  const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24]
  for (const k of keys) out.push(k.role, ...u32(k.index))
  const change = outputs.flatMap((o, n) => (o.change ? [{ n, ...o.change }] : []))
  out.push(change.length)
  for (const c of change) out.push(c.n & 0xff, c.n >> 8, c.role, ...u32(c.index))
  return Uint8Array.from([...out, ...bodyBytes])
}

// ---- Koios ----

async function koios(
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
  if (r.status < 200 || r.status > 299) throw new Error(`Koios answered ${r.status}`)
  return JSON.parse(r.text)
}

interface Utxo {
  tx_hash: string
  tx_index: number
  address: string
  value: string
  asset_list?: { policy_id: string; asset_name: string | null; quantity: string }[]
}

async function utxos(fetch: CoinFetch, network: 0 | 1, stake: string): Promise<Utxo[]> {
  return (await koios(fetch, network, 'POST', '/account_utxos', {
    _stake_addresses: [stake],
    _extended: true
  })) as Utxo[]
}

const assetsOf = (u: Utxo): Assets =>
  new Map((u.asset_list ?? []).map((a) => [a.policy_id + (a.asset_name ?? ''), BigInt(a.quantity)]))

const ada = (lovelace: bigint): string => {
  const frac = (lovelace % LOVELACE).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${lovelace / LOVELACE}.${frac}` : `${lovelace / LOVELACE}`
}

export const CARDANO: AccountChain = {
  id: 'cardano',
  name: 'Cardano',
  app: CARDANO_APP,
  glyph: 'cardano',
  tint: 'bg-blue/10 text-blue',
  units: ['ADA', 'tADA'],
  decimals: 6,
  priced: 'ADA',
  networks: ['Cardano', 'Preprod'],
  hint: 'addr1…',
  memo: null,
  wallets: 'The account Eternl, Lace, Yoroi and Ledger make',
  servers:
    'Balances and payments go through Koios, the Cardano community’s API, which sees the account’s stake address (so all its addresses) and this computer’s IP address. Every Cardano output carries at least about 1 ADA, and tokens travel with some.',
  explorerName: 'Cardanoscan',
  explorer: (network, kind, id) =>
    `https://${network === 0 ? '' : 'preprod.'}cardanoscan.io/${kind === 'tx' ? 'transaction' : 'address'}/${id}`,
  uri: (address) => `web+cardano:${address}`,
  valid: (address, network) => addressBytes(address, network) !== null,

  async look(fetch, account) {
    const network = account.network
    const keys = new Keys(accountKey(account))
    if (keys.address(network, 0, 0) !== account.address)
      throw new Error('maki’s Cardano key and its address don’t agree')
    const stake = keys.reward(network)
    const [info, coins] = await Promise.all([
      koios(fetch, network, 'POST', '/account_info', { _stake_addresses: [stake] }) as Promise<
        { rewards_available?: string }[]
      >,
      utxos(fetch, network, stake)
    ])
    const lovelace = coins.reduce((s, u) => s + BigInt(u.value), 0n)
    const tokens = new Map<string, bigint>()
    for (const u of coins)
      for (const [unit, q] of assetsOf(u)) tokens.set(unit, (tokens.get(unit) ?? 0n) + q)
    const holdings: Holding[] = [{ token: null, amount: lovelace }]
    let strangers = 0
    for (const [unit, q] of tokens) {
      const token = tokenOf(network, unit)
      if (token) holdings.push({ token, amount: q })
      else strangers++
    }
    const notes: string[] = []
    const rewards = BigInt(info[0]?.rewards_available ?? 0)
    if (rewards > 0n)
      notes.push(
        `${ada(rewards)} ADA of staking rewards wait to be withdrawn (by a wallet that does that).`
      )
    if (strangers > 0)
      notes.push(
        `It also holds ${strangers} token${strangers === 1 ? '' : 's'} maki doesn’t know: they aren’t shown here, and go with the change when their coins are spent.`
      )
    // history: the account's last transactions, what each did to it
    const activity: Activity[] = []
    try {
      const txs = (await koios(
        fetch,
        network,
        'POST',
        '/account_txs?order=block_height.desc&limit=16',
        {
          _stake_address: stake
        }
      )) as { tx_hash: string; block_time: number }[]
      for (let at = 0; at < txs.length; at += 8) {
        const info = (await koios(fetch, network, 'POST', '/tx_info', {
          _tx_hashes: txs.slice(at, at + 8).map((t) => t.tx_hash),
          _inputs: true,
          _metadata: false,
          _assets: false,
          _withdrawals: false,
          _certs: false,
          _scripts: false,
          _bytecode: false
        })) as {
          tx_hash: string
          tx_timestamp?: number
          inputs?: { stake_addr: string | null; value: string }[]
          outputs?: {
            stake_addr: string | null
            value: string
            payment_addr?: { bech32?: string }
          }[]
        }[]
        for (const t of info) {
          let net = 0n
          for (const i of t.inputs ?? []) if (i.stake_addr === stake) net -= BigInt(i.value)
          let to: string | undefined
          for (const o of t.outputs ?? [])
            if (o.stake_addr === stake) net += BigInt(o.value)
            else to ??= o.payment_addr?.bech32
          const time =
            txs.find((x) => x.tx_hash === t.tx_hash)?.block_time ?? t.tx_timestamp ?? null
          activity.push({
            id: t.tx_hash,
            kind: net < 0n ? 'Sent' : 'Received',
            amount: net,
            token: null,
            time,
            counterparty: net < 0n ? to : undefined
          })
        }
      }
    } catch {
      notes.push('Koios couldn’t be asked for the account’s history just now.')
    }
    activity.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    return { holdings, activity, reserved: 0n, exists: true, notes }
  },

  async pay(fetch, account, _state, to, amount, token) {
    const network = account.network
    const payTo = addressBytes(to, network)
    if (!payTo)
      throw new Error(
        `that isn’t a Cardano address maki desktop pays (${PREFIX.address[network]}1…; Byron’s aren’t)`
      )
    const keys = new Keys(accountKey(account))
    const stake = keys.reward(network)
    const [tip] = (await koios(fetch, network, 'GET', '/tip')) as {
      epoch_no: number
      abs_slot: number
    }[]
    const [[params], coins] = await Promise.all([
      koios(fetch, network, 'GET', `/epoch_params?_epoch_no=${tip.epoch_no}`) as Promise<
        { min_fee_a: number; min_fee_b: number; coins_per_utxo_size: string; max_tx_size: number }[]
      >,
      utxos(fetch, network, stake)
    ])
    const perByte = BigInt(params.coins_per_utxo_size)
    const minimum = (o: CardanoOutput): bigint => (160n + BigInt(output(o).length)) * perByte
    // each coin's key: the account's addresses, worked out until every coin's is found
    const where = new Map<string, { role: 0 | 1; index: number }>()
    for (let index = 0; index < 1000 && coins.some((u) => !where.has(u.address)); index++)
      for (const role of [0, 1] as const)
        where.set(keys.address(network, role, index), { role, index })
    const mine = coins.filter((u) => where.has(u.address))
    // the payment: its ADA (with tokens, the least an output carrying them holds), its tokens
    const pay: CardanoOutput = { address: payTo, lovelace: amount, assets: new Map() }
    const notes: string[] = []
    if (token) {
      pay.assets.set(token.id, amount)
      pay.lovelace = 0n
      pay.lovelace = minimum({ ...pay, lovelace: 2_000_000n })
      notes.push(
        `Cardano sends ${ada(pay.lovelace)} ADA with the tokens: an output can’t hold less.`
      )
    } else if (amount < minimum(pay))
      throw new Error(`a Cardano output holds at least ${ada(minimum(pay))} ADA`)
    // coins: those holding the token first, then the largest
    const order = [...mine].sort((a, b) => {
      const ta = token ? (assetsOf(a).get(token.id) ?? 0n) : 0n
      const tb = token ? (assetsOf(b).get(token.id) ?? 0n) : 0n
      if (ta !== tb) return ta > tb ? -1 : 1
      return BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0
    })
    const changeKey = { role: 1 as const, index: 0 }
    const changeAddress = keys.baseBytes(network, 1, 0)
    const ttl = BigInt(tip.abs_slot) + VALID_FOR
    for (let n = 1; n <= Math.min(MAX_INPUTS, order.length); n++) {
      const spent = order.slice(0, n)
      const inputs: CardanoInput[] = spent.map((u) => ({
        txid: u.tx_hash,
        index: u.tx_index,
        lovelace: BigInt(u.value),
        assets: assetsOf(u),
        ...(({ role, index }) => ({ role, keyIndex: index }))(where.get(u.address)!)
      }))
      const total = inputs.reduce((s, i) => s + i.lovelace, 0n)
      const left: Assets = new Map()
      for (const i of inputs)
        for (const [unit, q] of i.assets) left.set(unit, (left.get(unit) ?? 0n) + q)
      if (token) {
        const have = left.get(token.id) ?? 0n
        if (have < amount) continue
        left.set(token.id, have - amount)
      }
      const witnesses = [
        ...new Map(
          inputs.map((i) => [`${i.role}/${i.keyIndex}`, { role: i.role, index: i.keyIndex }])
        ).values()
      ]
      // the fee for a body this size, with this many witnesses: worked out until it settles
      const priced = (outputs: CardanoOutput[]): { fee: bigint; bytes: Uint8Array } => {
        let fee = 200_000n
        for (let k = 0; k < 4; k++) {
          const b = body(inputs, outputs, fee, ttl)
          const size = transaction(
            b,
            witnesses.map(() => [new Uint8Array(32), new Uint8Array(64)])
          ).length
          const need = BigInt(params.min_fee_a) * BigInt(size) + BigInt(params.min_fee_b)
          if (need === fee) return { fee, bytes: b }
          fee = need
        }
        return { fee, bytes: body(inputs, outputs, fee, ttl) }
      }
      const tokensLeft = [...left.values()].some((q) => q > 0n)
      // with change: whatever's left, back to the account's change address
      const change: CardanoOutput = {
        address: changeAddress,
        lovelace: 0n,
        assets: left,
        change: changeKey
      }
      let withChange = priced([pay, { ...change, lovelace: total - pay.lovelace }])
      change.lovelace = total - pay.lovelace - withChange.fee
      withChange = priced([pay, change])
      change.lovelace = total - pay.lovelace - withChange.fee
      if (change.lovelace >= minimum(change)) {
        const outputs = [pay, { ...change }]
        const final = priced(outputs)
        if (final.fee !== withChange.fee) continue
        return {
          payload: request(witnesses, outputs, final.bytes),
          fee: final.fee,
          feeIsMost: false,
          notes,
          carry: final.bytes
        }
      }
      // no change: only if there are no tokens left over, and what's left is little
      if (tokensLeft) continue
      const alone = priced([pay])
      const over = total - pay.lovelace - alone.fee
      if (over < 0n) continue
      if (over > 2n * LOVELACE) continue
      const final = body(inputs, [pay], alone.fee + over, ttl)
      if (over > 0n)
        notes.push(
          `The ${ada(over)} ADA left over is less than a Cardano output can hold: it goes with the fee.`
        )
      return {
        payload: request(witnesses, [pay], final),
        fee: alone.fee + over,
        feeIsMost: false,
        notes,
        carry: final
      }
    }
    throw new Error(
      order.length > MAX_INPUTS
        ? `that takes more than the ${MAX_INPUTS} largest coins: send less, or gather them first by sending to yourself`
        : `not enough ${token ? (token.symbol ?? 'of the token') + ' or ' : ''}ADA for that and the fee`
    )
  },

  async submit(fetch, account, payment, signature) {
    const bodyBytes = payment.carry as Uint8Array
    if (signature.length === 0 || signature.length % 96 !== 0)
      throw new Error('maki’s Cardano app gave signatures maki desktop can’t read')
    const witnesses: [Uint8Array, Uint8Array][] = []
    for (let at = 0; at < signature.length; at += 96)
      witnesses.push([signature.slice(at, at + 32), signature.slice(at + 32, at + 96)])
    const r = await fetch(
      account.network,
      'POST',
      '/submittx',
      hex.encode(transaction(bodyBytes, witnesses)),
      true
    )
    if (r.status < 200 || r.status > 299)
      throw new Error(`the network turned it down: ${r.text.slice(0, 300) || r.status}`)
    const id = transactionId(bodyBytes)
    let said: unknown = null
    try {
      said = JSON.parse(r.text)
    } catch {
      said = r.text.trim()
    }
    if (said !== id) throw new Error('Koios took a different transaction from the one maki signed')
    return id
  }
}
