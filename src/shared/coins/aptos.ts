/**
 * Aptos, for maki desktop's wallet: the account maki's Aptos app shares (Petra's and Ledger's, at
 * m/44'/637'/0'/0'/0'), what it holds (APT, and the stablecoins maki knows), what it's done, and
 * payments made as the app takes them to sign: the transaction as BCS (a `RawTransaction` calling
 * one of the transfers maki-apt reads), its gas worked out by simulating it first, then sent as a
 * signed transaction in BCS to Aptos Labs' API.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { sha3_256 } from '@noble/hashes/sha3.js'
import { hex } from '@scure/base'
import type { AccountChain, Activity, ChainToken, Holding } from '../account-chain'
import type { CoinFetch } from '../coin-servers'

export const APTOS_APP = 'com.leviathan.maki.aptos'
/** Octas in an APT. */
export const OCTAS = 100_000_000n
/** Each network's chain ID, which every transaction names. */
const CHAIN_ID = [1, 2] as const
/** How long a payment stays good for: room to go through it on maki. */
const VALID_FOR = 600n
/** APT's coin type, whose balance counts its paired fungible asset too. */
const APT_COIN = '0x1::aptos_coin::AptosCoin'
const LAYERZERO = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa'

/**
 * Assets maki knows, by network (as maki's Aptos app knows them, maki-apt's `assets`): a fungible
 * asset by its metadata's address, a coin by its type.
 */
const KNOWN: { network: 0 | 1; id: string; symbol: string; decimals: number }[] = [
  {
    network: 0,
    id: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
    symbol: 'USDC',
    decimals: 6
  },
  {
    network: 0,
    id: '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b',
    symbol: 'USDT',
    decimals: 6
  },
  { network: 0, id: `${LAYERZERO}::asset::USDC`, symbol: 'lzUSDC', decimals: 6 },
  { network: 0, id: `${LAYERZERO}::asset::USDT`, symbol: 'lzUSDT', decimals: 6 },
  {
    network: 1,
    id: '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832',
    symbol: 'USDC',
    decimals: 6
  }
]
/** Fungible assets' addresses that are APT, as the indexer names APT. */
const APT_IDS = [APT_COIN, `0x${'0'.repeat(63)}a`]

/** An address in full (0x and 64 hex digits) as its 32 bytes; null if it isn't one. */
export function addressBytes(address: string): Uint8Array | null {
  return /^0x[0-9a-fA-F]{64}$/.test(address) ? hex.decode(address.slice(2).toLowerCase()) : null
}

/** BCS: numbers little-endian, lengths as ULEB128 (the `bcs` crate's). */
class Bcs {
  private out: number[] = []
  u8(n: number): this {
    this.out.push(n & 0xff)
    return this
  }
  u64(n: bigint): this {
    for (let i = 0n; i < 8n; i++) this.out.push(Number((n >> (8n * i)) & 0xffn))
    return this
  }
  uleb(n: number): this {
    do {
      const b = n & 0x7f
      n = Math.floor(n / 128)
      this.out.push(n > 0 ? b | 0x80 : b)
    } while (n > 0)
    return this
  }
  fixed(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.out.push(b[i])
    return this
  }
  bytes(b: ArrayLike<number>): this {
    return this.uleb(b.length).fixed(b)
  }
  str(s: string): this {
    return this.bytes(new TextEncoder().encode(s))
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

/** A Move struct's type (`0x…::module::Name`) as a TypeTag: variant 7, a StructTag. */
function structTag(w: Bcs, type: string): void {
  const [address, module, name] = type.split('::')
  const a = addressBytes(address)
  if (!a || !module || !name) throw new Error(`not a coin type maki desktop knows: ${type}`)
  w.uleb(7).fixed(a).str(module).str(name).uleb(0)
}

/** What a payment calls: one of the transfers maki's Aptos app reads. */
export interface AptosCall {
  /** `0x1::aptos_account` and its function */
  function: 'transfer' | 'transfer_coins' | 'transfer_fungible_assets'
  /** a coin's type, for `transfer_coins` */
  coin?: string
  /** a fungible asset's metadata address, for `transfer_fungible_assets` */
  asset?: string
  to: string
  amount: bigint
}

export interface AptosPayment {
  sender: string
  sequence: bigint
  call: AptosCall
  maxGas: bigint
  gasPrice: bigint
  /** unix seconds */
  expiration: bigint
  network: 0 | 1
}

/** The transaction as BCS: what maki's app signs (after Aptos's prefix), as the SDK writes it. */
export function rawTransaction(p: AptosPayment): Uint8Array {
  const sender = addressBytes(p.sender)
  const to = addressBytes(p.call.to)
  if (!sender || !to) throw new Error('not an Aptos address')
  const w = new Bcs().fixed(sender).u64(p.sequence)
  // an entry function (payload variant 2), in 0x1::aptos_account
  w.uleb(2)
    .fixed(addressBytes(`0x${'0'.repeat(63)}1`)!)
    .str('aptos_account')
    .str(p.call.function)
  if (p.call.function === 'transfer_coins') {
    w.uleb(1)
    structTag(w, p.call.coin!)
  } else w.uleb(0)
  const amount = new Bcs().u64(p.call.amount).finish()
  if (p.call.function === 'transfer_fungible_assets') {
    const asset = addressBytes(p.call.asset!)
    if (!asset) throw new Error('not an asset maki desktop knows')
    w.uleb(3).bytes(asset).bytes(to).bytes(amount)
  } else w.uleb(2).bytes(to).bytes(amount)
  return w.u64(p.maxGas).u64(p.gasPrice).u64(p.expiration).u8(CHAIN_ID[p.network]).finish()
}

/** The signed transaction: the raw one, then its Ed25519 authenticator (the key, the signature). */
export function signedTransaction(
  raw: Uint8Array,
  publicKey: Uint8Array,
  signature: Uint8Array
): Uint8Array {
  return new Bcs().fixed(raw).uleb(0).bytes(publicKey).bytes(signature).finish()
}

/** A signed transaction's hash, its ID: SHA3-256 of Aptos's prefix, a user transaction's tag, it. */
export function transactionHash(signed: Uint8Array): string {
  const prefix = sha3_256(new TextEncoder().encode('APTOS::Transaction'))
  return `0x${hex.encode(sha3_256(Uint8Array.from([...prefix, 0, ...signed])))}`
}

async function call(
  fetch: CoinFetch,
  network: 0 | 1,
  method: 'GET' | 'POST',
  path: string,
  body?: string,
  binary?: boolean
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(network, method, path, body, binary)
  let json: unknown = null
  try {
    json = JSON.parse(r.text)
  } catch {
    // not JSON: the status says it
  }
  return { status: r.status, json }
}

/** A balance by coin type or asset address: 0 where there's none, or no such asset here. */
async function balance(
  fetch: CoinFetch,
  network: 0 | 1,
  address: string,
  id: string
): Promise<bigint> {
  const r = await call(fetch, network, 'GET', `/v1/accounts/${address}/balance/${id}`)
  if (r.status !== 200) return 0n
  return typeof r.json === 'number' || typeof r.json === 'string' ? BigInt(r.json) : 0n
}

function tokenOf(network: 0 | 1, id: string): ChainToken | null {
  const known = KNOWN.find((k) => k.network === network && k.id === id)
  return known ? { id, symbol: known.symbol, decimals: known.decimals } : null
}

/** What the account's last transactions did to it, from Aptos's indexer: by asset, in and out. */
const HISTORY = `query($a: String) {
  account_transactions(where: {account_address: {_eq: $a}}, order_by: {transaction_version: desc}, limit: 20) {
    transaction_version
    fungible_asset_activities(where: {owner_address: {_eq: $a}}) {
      amount type asset_type is_transaction_success transaction_timestamp is_gas_fee
    }
  }
}`

async function history(
  fetch: CoinFetch,
  network: 0 | 1,
  address: string
): Promise<Activity[] | null> {
  const r = await call(
    fetch,
    network,
    'POST',
    '/v1/graphql',
    JSON.stringify({ query: HISTORY, variables: { a: address } })
  )
  const data = (
    r.json as {
      data?: {
        account_transactions?: {
          transaction_version: number
          fungible_asset_activities: {
            amount: number | string | null
            type: string
            asset_type: string | null
            is_transaction_success: boolean
            transaction_timestamp: string
            is_gas_fee: boolean
          }[]
        }[]
      }
    } | null
  )?.data?.account_transactions
  if (r.status !== 200 || !data) return null
  return data.map((t) => {
    const net = new Map<string, bigint>()
    let gas = 0n
    let time: number | null = null
    let failed = false
    for (const a of t.fungible_asset_activities) {
      const amount = BigInt(a.amount ?? 0)
      time ??= Math.floor(Date.parse(`${a.transaction_timestamp}Z`) / 1000)
      failed ||= !a.is_transaction_success
      if (a.is_gas_fee) {
        gas += amount
        continue
      }
      const asset = APT_IDS.includes(a.asset_type ?? '') ? APT_COIN : (a.asset_type ?? '')
      const sign = /Withdraw/.test(a.type) ? -1n : /Deposit/.test(a.type) ? 1n : 0n
      net.set(asset, (net.get(asset) ?? 0n) + sign * amount)
    }
    // the asset that moved most; with only the fee, that
    const [asset, amount] = [...net.entries()].sort((x, y) =>
      (y[1] < 0n ? -y[1] : y[1]) > (x[1] < 0n ? -x[1] : x[1]) ? 1 : -1
    )[0] ?? [APT_COIN, -gas]
    const token = asset === APT_COIN ? null : tokenOf(network, asset)
    return {
      id: String(t.transaction_version),
      kind: amount > 0n ? 'Received' : net.size ? 'Sent' : 'Transaction',
      // an asset maki doesn't know: what it was, not how much
      amount: asset === APT_COIN || token ? amount : null,
      token: asset === APT_COIN ? null : (token ?? { id: asset, symbol: null, decimals: 0 }),
      time,
      failed
    }
  })
}

export const APTOS: AccountChain = {
  id: 'aptos',
  name: 'Aptos',
  app: APTOS_APP,
  glyph: 'aptos',
  tint: 'bg-subtext1/10 text-subtext1',
  units: ['APT', 'tAPT'],
  decimals: 8,
  priced: 'APT',
  networks: ['Aptos', 'Testnet'],
  hint: '0x…',
  memo: null,
  wallets: 'The account Petra and Ledger make',
  servers:
    'Balances and payments go through Aptos Labs’ API, and history through its indexer, which see the account’s address and this computer’s IP address; the indexer turns a busy computer away for a few minutes.',
  explorerName: 'the Aptos explorer',
  explorer: (network, kind, id) =>
    `https://explorer.aptoslabs.com/${kind === 'tx' ? 'txn' : 'account'}/${id}?network=${network === 0 ? 'mainnet' : 'testnet'}`,
  uri: (address) => address,
  valid: (address) => addressBytes(address) !== null,

  async look(fetch, account) {
    const network = account.network
    const a = await call(fetch, network, 'GET', `/v1/accounts/${account.address}`)
    const info = a.json as { sequence_number?: string; authentication_key?: string } | null
    if (a.status !== 200 && a.status !== 404)
      throw new Error(`Aptos Labs’ API answered ${a.status}`)
    const notes: string[] = []
    if (info?.authentication_key && info.authentication_key !== account.address)
      notes.push(
        'This account’s key has been changed on Aptos: maki’s key no longer signs for it, and payments from it will fail.'
      )
    const holdings: Holding[] = [
      { token: null, amount: await balance(fetch, network, account.address, APT_COIN) }
    ]
    for (const k of KNOWN.filter((k) => k.network === network)) {
      const amount = await balance(fetch, network, account.address, k.id)
      if (amount > 0n) holdings.push({ token: tokenOf(network, k.id), amount })
    }
    let activity = await history(fetch, network, account.address)
    if (activity === null) {
      // the indexer's busy: what the account sent, from the API itself
      const r = await call(
        fetch,
        network,
        'GET',
        `/v1/accounts/${account.address}/transactions?limit=20`
      )
      const sent = (Array.isArray(r.json) ? r.json : []) as {
        version: string
        timestamp: string
        success: boolean
        payload?: { function?: string; arguments?: unknown[] }
      }[]
      activity = sent.reverse().map((t) => ({
        id: t.version,
        kind: 'Sent',
        amount:
          t.payload?.function === '0x1::aptos_account::transfer'
            ? -BigInt(String(t.payload.arguments?.[1] ?? 0))
            : null,
        token: null,
        time: Math.floor(Number(t.timestamp) / 1_000_000),
        counterparty:
          typeof t.payload?.arguments?.[0] === 'string'
            ? (t.payload.arguments[0] as string)
            : undefined,
        failed: !t.success
      }))
      notes.push('Aptos’s indexer is busy: only what the account sent is listed for now.')
    }
    return { holdings, activity, reserved: 0n, exists: true, notes }
  },

  async pay(fetch, account, _state, to, amount, token) {
    const network = account.network
    const recipient = to.toLowerCase()
    if (!addressBytes(recipient))
      throw new Error('that isn’t an Aptos address (0x and 64 hex digits)')
    const [a, price] = await Promise.all([
      call(fetch, network, 'GET', `/v1/accounts/${account.address}`),
      call(fetch, network, 'GET', '/v1/estimate_gas_price')
    ])
    const sequence = BigInt((a.json as { sequence_number?: string } | null)?.sequence_number ?? 0)
    const gasPrice = BigInt(
      Math.max(100, (price.json as { gas_estimate?: number } | null)?.gas_estimate ?? 100)
    )
    const call0: AptosCall = !token
      ? { function: 'transfer', to: recipient, amount }
      : token.id.includes('::')
        ? { function: 'transfer_coins', coin: token.id, to: recipient, amount }
        : { function: 'transfer_fungible_assets', asset: token.id, to: recipient, amount }
    const payment: AptosPayment = {
      sender: account.address,
      sequence,
      call: call0,
      maxGas: 100_000n,
      gasPrice,
      expiration: BigInt(Math.floor(Date.now() / 1000)) + VALID_FOR,
      network
    }
    // what it takes, simulated as it'll be sent (signed with nothing: a simulation's isn't checked)
    const key = hex.decode(account.publicKey)
    const sim = await call(
      fetch,
      network,
      'POST',
      '/v1/transactions/simulate?estimate_max_gas_amount=true&estimate_gas_unit_price=true',
      hex.encode(signedTransaction(rawTransaction(payment), key, new Uint8Array(64))),
      true
    )
    const result = (Array.isArray(sim.json) ? sim.json[0] : null) as {
      success?: boolean
      vm_status?: string
      gas_used?: string
    } | null
    if (sim.status !== 200 || !result)
      throw new Error(`Aptos Labs’ API couldn’t try it (${sim.status})`)
    if (!result.success)
      throw new Error(
        /INSUFFICIENT_BALANCE|EINSUFFICIENT_BALANCE/.test(result.vm_status ?? '')
          ? 'not enough for that and the fee'
          : `Aptos would turn it down: ${result.vm_status}`
      )
    // room over what it used, as Aptos's wallets leave
    const used = BigInt(result.gas_used ?? 0)
    payment.maxGas = used + used / 2n + 10n
    const raw = rawTransaction(payment)
    return {
      payload: raw,
      fee: payment.maxGas * gasPrice,
      feeIsMost: true,
      notes: [],
      carry: raw
    }
  },

  async submit(fetch, account, payment, signature) {
    if (signature.length !== 64)
      throw new Error('maki’s Aptos app gave a signature maki desktop can’t read')
    const signed = signedTransaction(
      payment.carry as Uint8Array,
      hex.decode(account.publicKey),
      signature
    )
    const r = await call(
      fetch,
      account.network,
      'POST',
      '/v1/transactions',
      hex.encode(signed),
      true
    )
    const body = r.json as { hash?: string; message?: string; vm_error_code?: number } | null
    if (r.status !== 202 || !body?.hash)
      throw new Error(`the network turned it down: ${body?.message ?? r.status}`)
    if (body.hash !== transactionHash(signed))
      throw new Error('Aptos Labs’ API took a different transaction from the one maki signed')
    return body.hash
  }
}
