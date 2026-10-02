/**
 * Cosmos, for maki desktop's wallet: the account maki's Cosmos app shares on each chain it serves
 * (the Cosmos Hub and the chains that share its keys, `m/44'/118'/0'/0/0`, Keplr's and CosmJS's),
 * what it holds and has done there (each chain's REST API, through cosmos.directory), and payments
 * (a bank send) made as the app takes them to sign: an Amino JSON sign doc, serialized as CosmJS
 * serializes it and the chain rebuilds it, its gas found by simulating it; then the transaction in
 * protobuf (TxRaw), maki's signature in it, broadcast.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, bech32, hex } from '@scure/base'
import type { AccountChain, Activity } from '../account-chain'
import type { CoinFetch, CoinId } from '../coin-servers'
import { COSMOS_APP } from '../wallet-apps'

/** A chain maki's Cosmos app serves, as the wallet needs it (maki-atom's `chains`, the registry's fees). */
export interface CosmosSpec {
  id: CoinId
  name: string
  chainIds: [string, string | null]
  prefix: string
  denom: string
  symbol: string
  decimals: number
  /** its gas price: the fee market's, Osmosis's base fee, or the chain registry's average */
  gas: { kind: 'feemarket' } | { kind: 'osmosis' } | { kind: 'fixed'; price: number }
  /** Mintscan's name for it (Juno: ping.pub's), on each network */
  explorer: [string, string | null]
}

export const COSMOS_CHAINS: CosmosSpec[] = [
  {
    id: 'cosmos',
    name: 'Cosmos Hub',
    chainIds: ['cosmoshub-4', 'provider'],
    prefix: 'cosmos',
    denom: 'uatom',
    symbol: 'ATOM',
    decimals: 6,
    gas: { kind: 'feemarket' },
    explorer: ['cosmos', 'ics-testnet-provider']
  },
  {
    id: 'osmosis',
    name: 'Osmosis',
    chainIds: ['osmosis-1', 'osmo-test-5'],
    prefix: 'osmo',
    denom: 'uosmo',
    symbol: 'OSMO',
    decimals: 6,
    gas: { kind: 'osmosis' },
    explorer: ['osmosis', 'osmosis-testnet']
  },
  {
    id: 'celestia',
    name: 'Celestia',
    chainIds: ['celestia', 'mocha-5'],
    prefix: 'celestia',
    denom: 'utia',
    symbol: 'TIA',
    decimals: 6,
    gas: { kind: 'fixed', price: 0.02 },
    explorer: ['celestia', null]
  },
  {
    id: 'noble',
    name: 'Noble',
    chainIds: ['noble-1', null],
    prefix: 'noble',
    denom: 'uusdc',
    symbol: 'USDC',
    decimals: 6,
    gas: { kind: 'fixed', price: 0.1 },
    explorer: ['noble', null]
  },
  {
    id: 'dydx',
    name: 'dYdX',
    chainIds: ['dydx-mainnet-1', null],
    prefix: 'dydx',
    denom: 'adydx',
    symbol: 'DYDX',
    decimals: 18,
    gas: { kind: 'fixed', price: 12_500_000_000 },
    explorer: ['dydx', null]
  },
  {
    id: 'neutron',
    name: 'Neutron',
    chainIds: ['neutron-1', null],
    prefix: 'neutron',
    denom: 'untrn',
    symbol: 'NTRN',
    decimals: 6,
    gas: { kind: 'feemarket' },
    explorer: ['neutron', null]
  },
  {
    id: 'akash',
    name: 'Akash',
    chainIds: ['akashnet-2', null],
    prefix: 'akash',
    denom: 'uakt',
    symbol: 'AKT',
    decimals: 6,
    gas: { kind: 'fixed', price: 0.025 },
    explorer: ['akash', null]
  },
  {
    id: 'axelar',
    name: 'Axelar',
    chainIds: ['axelar-dojo-1', null],
    prefix: 'axelar',
    denom: 'uaxl',
    symbol: 'AXL',
    decimals: 6,
    gas: { kind: 'fixed', price: 0.007 },
    explorer: ['axelar', null]
  },
  {
    id: 'babylon',
    name: 'Babylon',
    chainIds: ['bbn-1', null],
    prefix: 'bbn',
    denom: 'ubbn',
    symbol: 'BABY',
    decimals: 6,
    gas: { kind: 'fixed', price: 0.007 },
    explorer: ['babylon', null]
  },
  {
    id: 'juno',
    name: 'Juno',
    chainIds: ['juno-1', null],
    prefix: 'juno',
    denom: 'ujuno',
    symbol: 'JUNO',
    decimals: 6,
    gas: { kind: 'fixed', price: 0.1 },
    explorer: ['juno', null]
  }
]

/** The account's address on a chain: RIPEMD-160 of SHA-256 of its compressed key, in bech32. */
export const addressOf = (key: Uint8Array, prefix: string): string =>
  bech32.encode(prefix, bech32.toWords(ripemd160(sha256(key))))

/** The 20 bytes an address on `prefix`'s chain holds; null if it isn't one. */
export function addressBytes(address: string, prefix: string): Uint8Array | null {
  try {
    const { prefix: p, words } = bech32.decode(address as `${string}1${string}`, 90)
    const b = bech32.fromWords(words)
    return p === prefix && (b.length === 20 || b.length === 32) ? b : null
  } catch {
    return null
  }
}

// ---- the sign doc: Amino JSON, as CosmJS's serializeSignDoc writes it ----

export interface CosmosSend {
  chainId: string
  accountNumber: string
  sequence: string
  from: string
  to: string
  denom: string
  amount: bigint
  fee: bigint
  gas: bigint
  memo: string
}

/** JSON with its keys sorted, no spaces, and <, > and & escaped, as CosmJS (and the chain) writes it. */
function sorted(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sorted).join(',')}]`
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sorted((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

/** The sign doc's bytes: what maki's app reads and signs the SHA-256 of. */
export function signDoc(s: CosmosSend): Uint8Array {
  const doc = {
    account_number: s.accountNumber,
    chain_id: s.chainId,
    fee: {
      amount: s.fee > 0n ? [{ amount: s.fee.toString(), denom: s.denom }] : [],
      gas: s.gas.toString()
    },
    memo: s.memo,
    msgs: [
      {
        type: 'cosmos-sdk/MsgSend',
        value: {
          amount: [{ amount: s.amount.toString(), denom: s.denom }],
          from_address: s.from,
          to_address: s.to
        }
      }
    ],
    sequence: s.sequence
  }
  const text = sorted(doc)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
  return new TextEncoder().encode(text)
}

// ---- the transaction: protobuf ----

/** Protocol buffers, as the chain's types have them: fields in order, nothing at its default. */
class Proto {
  private out: number[] = []
  private varint(n: bigint): this {
    let v = n
    do {
      const b = Number(v & 0x7fn)
      v >>= 7n
      this.out.push(v > 0n ? b | 0x80 : b)
    } while (v > 0n)
    return this
  }
  uint(field: number, n: bigint): this {
    return n === 0n ? this : this.varint(BigInt(field << 3)).varint(n)
  }
  bytes(field: number, b: Uint8Array): this {
    if (b.length === 0) return this
    this.varint(BigInt((field << 3) | 2)).varint(BigInt(b.length))
    for (const x of b) this.out.push(x)
    return this
  }
  str(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s))
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

const coin = (denom: string, amount: bigint): Uint8Array =>
  new Proto().str(1, denom).str(2, amount.toString()).finish()

/** The transaction a sign doc stands for, with its signature (empty to simulate it), as TxRaw. */
export function txRaw(s: CosmosSend, publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
  const send = new Proto().str(1, s.from).str(2, s.to).bytes(3, coin(s.denom, s.amount)).finish()
  const any = new Proto().str(1, '/cosmos.bank.v1beta1.MsgSend').bytes(2, send).finish()
  const body = new Proto().bytes(1, any).str(2, s.memo).finish()
  const key = new Proto()
    .str(1, '/cosmos.crypto.secp256k1.PubKey')
    .bytes(2, new Proto().bytes(1, publicKey).finish())
    .finish()
  // SIGN_MODE_LEGACY_AMINO_JSON: what maki's app signs
  const mode = new Proto().bytes(1, new Proto().uint(1, 127n).finish()).finish()
  const signer = new Proto().bytes(1, key).bytes(2, mode).uint(3, BigInt(s.sequence)).finish()
  const fee = new Proto()
  if (s.fee > 0n) fee.bytes(1, coin(s.denom, s.fee))
  const authInfo = new Proto().bytes(1, signer).bytes(2, fee.uint(2, s.gas).finish()).finish()
  const raw = new Proto().bytes(1, body).bytes(2, authInfo).finish()
  // a signature, even an empty one, is always there
  return Uint8Array.from([...raw, 0x1a, signature.length, ...signature])
}

/** A transaction's hash, as the chains show it: upper-case hex of the SHA-256 of TxRaw. */
export const transactionHash = (raw: Uint8Array): string => hex.encode(sha256(raw)).toUpperCase()

// ---- the chain's REST API ----

async function get(
  fetch: CoinFetch,
  network: 0 | 1,
  path: string
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(network, 'GET', path)
  let json: unknown = null
  try {
    json = JSON.parse(r.text)
  } catch {
    // the status says it
  }
  return { status: r.status, json }
}

/** The account's number and sequence, or null if the chain hasn't seen the account. */
async function accountOf(
  fetch: CoinFetch,
  network: 0 | 1,
  address: string
): Promise<{ number: string; sequence: string } | null> {
  const r = await get(fetch, network, `/cosmos/auth/v1beta1/accounts/${address}`)
  if (r.status === 404) return null
  const a = (r.json as { account?: Record<string, unknown> } | null)?.account
  if (!a) throw new Error(`the chain answered ${r.status}`)
  // a vesting account keeps them a level down
  const base = (a.base_account ??
    (a.base_vesting_account as Record<string, unknown> | undefined)?.base_account ??
    a) as {
    account_number?: string
    sequence?: string
  }
  return { number: String(base.account_number ?? '0'), sequence: String(base.sequence ?? '0') }
}

async function gasPrice(fetch: CoinFetch, network: 0 | 1, spec: CosmosSpec): Promise<number> {
  try {
    if (spec.gas.kind === 'feemarket') {
      const r = await get(fetch, network, `/feemarket/v1/gas_price/${spec.denom}`)
      return Number((r.json as { price?: { amount?: string } }).price?.amount)
    }
    if (spec.gas.kind === 'osmosis') {
      const r = await get(fetch, network, '/osmosis/txfees/v1beta1/cur_eip_base_fee')
      return Number((r.json as { base_fee?: string }).base_fee)
    }
  } catch {
    // the registry's, below
  }
  return spec.gas.kind === 'fixed' ? spec.gas.price : spec.gas.kind === 'feemarket' ? 0.025 : 0.1
}

/** A chain's wallet, from its description. */
export function cosmosChain(spec: CosmosSpec): AccountChain {
  return {
    id: spec.id,
    name: spec.name,
    app: COSMOS_APP,
    glyph: 'cosmos',
    tint: 'bg-mauve/10 text-mauve',
    units: [spec.symbol, `t${spec.symbol}`],
    decimals: spec.decimals,
    priced: spec.symbol,
    networks: [spec.name, spec.chainIds[1] ? 'Testnet' : null],
    appChain: spec.chainIds,
    hint: `${spec.prefix}1…`,
    memo: { label: 'Memo', placeholder: 'if the recipient asked for one', numeric: false },
    wallets: 'The account Keplr, Cosmostation and Ledger make',
    servers: `Balances and payments go through ${spec.name}’s public API (by cosmos.directory), which sees the account’s address and this computer’s IP address. Public nodes forget old transactions, so the history here may be short.`,
    explorerName: spec.id === 'juno' ? 'ping.pub' : 'Mintscan',
    explorer: (network, kind, id) => {
      const slug = spec.explorer[network] ?? spec.explorer[0]
      return spec.id === 'juno'
        ? `https://ping.pub/juno/${kind === 'tx' ? 'tx' : 'account'}/${id}`
        : `https://www.mintscan.io/${slug}/${kind === 'tx' ? 'tx' : 'address'}/${id}`
    },
    uri: (address) => address,
    valid: (address) => addressBytes(address, spec.prefix) !== null,

    async look(fetch, account) {
      const network = account.network
      const key = hex.decode(account.publicKey)
      if (addressOf(key, spec.prefix) !== account.address)
        throw new Error(`maki’s ${spec.name} key and its address don’t agree`)
      const b = await get(fetch, network, `/cosmos/bank/v1beta1/balances/${account.address}`)
      const balances =
        (b.json as { balances?: { denom: string; amount: string }[] } | null)?.balances ?? []
      const amount = BigInt(balances.find((x) => x.denom === spec.denom)?.amount ?? '0')
      const others = balances.filter((x) => x.denom !== spec.denom && x.amount !== '0').length
      const notes: string[] = []
      if (others > 0)
        notes.push(
          `It also holds ${others} other coin${others === 1 ? '' : 's'} (from other chains, or made on this one): they aren’t shown here.`
        )
      const seen = new Map<string, Activity>()
      for (const query of [
        `message.sender='${account.address}'`,
        `transfer.recipient='${account.address}'`
      ]) {
        try {
          const r = await get(
            fetch,
            network,
            `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(query).replace(/'/g, '%27')}&order_by=ORDER_BY_DESC&pagination.limit=10`
          )
          const txs =
            (r.json as { tx_responses?: Record<string, unknown>[] } | null)?.tx_responses ?? []
          for (const t of txs) {
            const hash = String(t.txhash)
            if (seen.has(hash)) continue
            const msgs =
              (t.tx as { body?: { messages?: Record<string, unknown>[] } } | undefined)?.body
                ?.messages ?? []
            const send = msgs.find((m) => m['@type'] === '/cosmos.bank.v1beta1.MsgSend')
            const coins = (send?.amount as { denom: string; amount: string }[] | undefined) ?? []
            const value = BigInt(coins.find((c) => c.denom === spec.denom)?.amount ?? '0')
            const out = send?.from_address === account.address
            seen.set(hash, {
              id: hash,
              kind: send
                ? out
                  ? 'Sent'
                  : 'Received'
                : String(msgs[0]?.['@type'] ?? 'Transaction')
                    .split('.')
                    .pop()!
                    .replace(/^Msg/, ''),
              amount: send ? (out ? -value : value) : null,
              token: null,
              time:
                typeof t.timestamp === 'string' ? Math.floor(Date.parse(t.timestamp) / 1000) : null,
              counterparty: send ? String(out ? send.to_address : send.from_address) : undefined,
              failed: Number(t.code ?? 0) !== 0
            })
          }
        } catch {
          // a node that keeps no history: none shown
        }
      }
      const activity = [...seen.values()].sort((x, y) => (y.time ?? 0) - (x.time ?? 0))
      return { holdings: [{ token: null, amount }], activity, reserved: 0n, exists: true, notes }
    },

    async pay(fetch, account, _state, to, amount, _token, memo) {
      const network = account.network
      const chainId = spec.chainIds[network]
      if (!chainId) throw new Error(`maki’s Cosmos app knows no test network for ${spec.name}`)
      if (!addressBytes(to, spec.prefix))
        throw new Error(`that isn’t an address on ${spec.name} (${spec.prefix}1…)`)
      const [acct, price] = await Promise.all([
        accountOf(fetch, network, account.address),
        gasPrice(fetch, network, spec)
      ])
      if (!acct)
        throw new Error(`${spec.name} hasn’t seen this account yet: it has nothing to send`)
      const key = hex.decode(account.publicKey)
      const send: CosmosSend = {
        chainId,
        accountNumber: acct.number,
        sequence: acct.sequence,
        from: account.address,
        to,
        denom: spec.denom,
        amount,
        fee: 0n,
        gas: 200_000n,
        memo
      }
      // what it takes, simulated (with an empty signature, as CosmJS simulates)
      const r = await fetch(
        network,
        'POST',
        '/cosmos/tx/v1beta1/simulate',
        JSON.stringify({ tx_bytes: base64.encode(txRaw(send, key, new Uint8Array())) })
      )
      const sim = JSON.parse(r.text) as { gas_info?: { gas_used?: string }; message?: string }
      if (r.status !== 200 || !sim.gas_info?.gas_used)
        throw new Error(
          /insufficient funds/.test(sim.message ?? '')
            ? 'not enough for that and the fee'
            : `${spec.name} would turn it down: ${sim.message ?? r.status}`
        )
      send.gas = (BigInt(sim.gas_info.gas_used) * 14n) / 10n + 1n
      // the fee: the gas at the chain's price, rounded up (as an exact decimal, never a float's sum)
      const [whole, frac = ''] = price.toFixed(12).split('.')
      const scaled = BigInt(whole + frac.padEnd(12, '0'))
      send.fee = (send.gas * scaled + 10n ** 12n - 1n) / 10n ** 12n
      return { payload: signDoc(send), fee: send.fee, feeIsMost: true, notes: [], carry: send }
    },

    async submit(fetch, account, payment, signature) {
      if (signature.length !== 64)
        throw new Error('maki’s Cosmos app gave a signature maki desktop can’t read')
      const raw = txRaw(payment.carry as CosmosSend, hex.decode(account.publicKey), signature)
      const r = await fetch(
        account.network,
        'POST',
        '/cosmos/tx/v1beta1/txs',
        JSON.stringify({ tx_bytes: base64.encode(raw), mode: 'BROADCAST_MODE_SYNC' })
      )
      const body = JSON.parse(r.text) as {
        tx_response?: { txhash?: string; code?: number; raw_log?: string }
        message?: string
      }
      const t = body.tx_response
      if (r.status !== 200 || !t?.txhash || (t.code ?? 0) !== 0)
        throw new Error(`the network turned it down: ${t?.raw_log ?? body.message ?? r.status}`)
      if (t.txhash !== transactionHash(raw))
        throw new Error(`${spec.name}’s API took a different transaction from the one maki signed`)
      return t.txhash
    }
  }
}

export const COSMOS = COSMOS_CHAINS.map(cosmosChain)
