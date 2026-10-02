/**
 * Tron, for maki desktop's wallet: TRX, and TRC-20 tokens (USDT above all). Payments are made here
 * as the transaction's `raw_data`, written as java-tron writes it (protobuf: fields in order,
 * nothing at its default), from a recent block's header, good for ten minutes; maki's Tron app
 * reads it back, shows it (where it goes, the token, how much, the most the fee can be) and signs
 * its SHA-256, which is its ID too. The signature goes in, and the transaction to TronGrid.
 * Balances, history, the block header and broadcasting through TronGrid, keyless.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { createBase58check, hex } from '@scure/base'
import type { AccountChain, Activity, ChainToken, Holding } from '../account-chain'
import type { CoinFetch } from '../coin-servers'

export const TRON_APP = 'com.leviathan.maki.tron'

/** Sun in a TRX. */
export const SUN = 1_000_000n
/** How long a payment stays good for: room to go through it on maki. */
const VALID_MS = 10 * 60_000
/** What a token transfer may burn for energy when it can't be worked out: a cap, not a price. */
const FEE_LIMIT_FALLBACK = 50n * SUN

const b58 = createBase58check(sha256)

/** An address's 21 bytes (0x41, then 20) from its text (`T…`); null if it isn't one of Tron's. */
export function addressBytes(text: string): Uint8Array | null {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(text)) return null
  try {
    const b = b58.decode(text)
    return b.length === 21 && b[0] === 0x41 ? b : null
  } catch {
    return null
  }
}

export const addressText = (b: Uint8Array): string => b58.encode(b)

/** The address of an uncompressed key (`04 ‖ x ‖ y`): 0x41 and the last 20 bytes of its Keccak-256. */
export function addressOfKey(key: Uint8Array): string {
  if (key.length !== 65 || key[0] !== 4) throw new Error('not an uncompressed key')
  return addressText(Uint8Array.from([0x41, ...keccak_256(key.subarray(1)).slice(12)]))
}

/** Protobuf, as java-tron writes it: varints, and lengths before bytes. */
class Proto {
  private out: number[] = []
  private varint(n: bigint): void {
    do {
      let b = Number(n & 0x7fn)
      n >>= 7n
      if (n > 0n) b |= 0x80
      this.out.push(b)
    } while (n > 0n)
  }
  /** An integer field; one at its default (0) isn't written. */
  int(field: number, n: bigint | number): this {
    const v = BigInt(n)
    if (v === 0n) return this
    this.varint(BigInt(field << 3))
    this.varint(v)
    return this
  }
  /** A bytes field; an empty one isn't written. */
  bytes(field: number, b: Uint8Array): this {
    if (b.length === 0) return this
    this.varint(BigInt((field << 3) | 2))
    this.varint(BigInt(b.length))
    this.out.push(...b)
    return this
  }
  done(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** What a transaction is made from: the recent block it names, its times, and its contract. */
export interface TronPayment {
  /** the block's number's last two bytes, and bytes 8 to 16 of its ID */
  refBlockBytes: Uint8Array
  refBlockHash: Uint8Array
  /** milliseconds */
  timestamp: number
  expiration: number
  owner: string
  to: string
  /** sun, or a token's smallest units */
  amount: bigint
  /** a TRC-20 token's contract, for a token payment */
  token?: string
  /** the most a token payment may burn for energy, sun */
  feeLimit?: bigint
  memo?: string
}

/** The transaction's `raw_data`: what's signed, and what its ID is the SHA-256 of. */
export function rawData(p: TronPayment): Uint8Array {
  const owner = addressBytes(p.owner)
  const to = addressBytes(p.to)
  if (!owner || !to) throw new Error('not a Tron address')
  let type: number
  let name: string
  let value: Uint8Array
  if (p.token) {
    const contract = addressBytes(p.token)
    if (!contract) throw new Error('not a token’s contract')
    // TRC-20's transfer(address,uint256): the recipient as a 32-byte word (its 20 bytes), the amount
    const data = Uint8Array.from([
      ...hex.decode('a9059cbb'),
      ...new Uint8Array(12),
      ...to.subarray(1),
      ...hex.decode(p.amount.toString(16).padStart(64, '0'))
    ])
    type = 31
    name = 'TriggerSmartContract'
    value = new Proto().bytes(1, owner).bytes(2, contract).bytes(4, data).done()
  } else {
    type = 1
    name = 'TransferContract'
    value = new Proto().bytes(1, owner).bytes(2, to).int(3, p.amount).done()
  }
  const any = new Proto()
    .bytes(1, utf8(`type.googleapis.com/protocol.${name}`))
    .bytes(2, value)
    .done()
  const contract = new Proto().int(1, type).bytes(2, any).done()
  return new Proto()
    .bytes(1, p.refBlockBytes)
    .bytes(4, p.refBlockHash)
    .int(8, p.expiration)
    .bytes(10, utf8(p.memo ?? ''))
    .bytes(11, contract)
    .int(14, p.timestamp)
    .int(18, p.token ? (p.feeLimit ?? FEE_LIMIT_FALLBACK) : 0)
    .done()
}

/** A transaction's ID (and what's signed): SHA-256 of its `raw_data`, in hex. */
export const txid = (raw: Uint8Array): string => hex.encode(sha256(raw))

/** The signed transaction as `broadcasthex` takes it: `raw_data` (field 1), then the signature (field 2). */
export function signedTransaction(raw: Uint8Array, signature: Uint8Array): Uint8Array {
  return new Proto().bytes(1, raw).bytes(2, signature).done()
}

/** Tokens maki knows, by network and contract (as maki's Tron app knows them). */
const KNOWN: { network: 0 | 1; contract: string; symbol: string; decimals: number }[] = [
  { network: 0, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', decimals: 6 },
  { network: 0, contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', symbol: 'USDC (old)', decimals: 6 },
  { network: 0, contract: 'TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz', symbol: 'USDD', decimals: 18 },
  { network: 0, contract: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', symbol: 'WTRX', decimals: 6 },
  { network: 1, contract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', symbol: 'USDT (Nile)', decimals: 6 }
]

function tokenOf(network: 0 | 1, contract: string, decimals?: number, symbol?: string): ChainToken {
  const known = KNOWN.find((k) => k.network === network && k.contract === contract)
  return {
    id: contract,
    symbol: known?.symbol ?? null,
    decimals: known?.decimals ?? decimals ?? 0,
    label: known ? undefined : symbol ? `${symbol} (${contract.slice(0, 6)}…)` : undefined
  }
}

async function json(
  fetch: CoinFetch,
  network: 0 | 1,
  method: 'GET' | 'POST',
  path: string,
  body?: object
): Promise<Record<string, unknown>> {
  const r = await fetch(
    network,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body)
  )
  if (r.status !== 200) throw new Error(`TronGrid answered ${r.status}`)
  return JSON.parse(r.text)
}

/** A recent block's header, as a transaction names it, and the time to start counting from. */
async function recentBlock(
  fetch: CoinFetch,
  network: 0 | 1
): Promise<{ bytes: Uint8Array; hash: Uint8Array; time: number }> {
  const b = (await json(fetch, network, 'POST', '/wallet/getnowblock')) as {
    blockID?: string
    block_header?: { raw_data?: { number?: number; timestamp?: number } }
  }
  const number = b.block_header?.raw_data?.number
  if (!b.blockID || !/^[0-9a-f]{64}$/.test(b.blockID) || typeof number !== 'number')
    throw new Error('TronGrid didn’t say the latest block')
  const n = BigInt(number)
  return {
    bytes: Uint8Array.of(Number((n >> 8n) & 0xffn), Number(n & 0xffn)),
    hash: hex.decode(b.blockID.slice(16, 32)),
    time: b.block_header?.raw_data?.timestamp ?? Date.now()
  }
}

export const TRON: AccountChain = {
  id: 'tron',
  name: 'Tron',
  app: TRON_APP,
  glyph: 'tron',
  tint: 'bg-red/10 text-red',
  units: ['TRX', 'tTRX'],
  decimals: 6,
  priced: 'TRX',
  networks: ['Tron', 'Nile'],
  hint: 'T…',
  memo: null,
  wallets: 'The account TronLink and Ledger make',
  servers:
    'Balances and payments go through TronGrid, Tron’s public servers, which see the account’s address and this computer’s IP address. A token payment burns some TRX for energy unless the account has staked for it; maki shows the most it can.',
  explorerName: 'tronscan.org',
  explorer: (network, kind, id) =>
    `https://${network === 0 ? '' : 'nile.'}tronscan.org/#/${kind === 'tx' ? 'transaction' : 'address'}/${id}`,
  uri: (address) => address,
  valid: (address) => addressBytes(address) !== null,

  async look(fetch, account) {
    const network = account.network
    const a = (await json(fetch, network, 'GET', `/v1/accounts/${account.address}`)) as {
      data?: { balance?: number; trc20?: Record<string, string>[] }[]
    }
    const data = a.data?.[0]
    const holdings: Holding[] = [{ token: null, amount: BigInt(data?.balance ?? 0) }]
    // tokens maki knows; Tron's accounts collect others unasked, often scams posing as real ones
    // (their names say anything), so those are counted, not shown
    let strangers = 0
    for (const entry of data?.trc20 ?? [])
      for (const [contract, amount] of Object.entries(entry)) {
        if (!/^\d+$/.test(amount)) continue
        if (KNOWN.some((k) => k.network === network && k.contract === contract))
          holdings.push({ token: tokenOf(network, contract), amount: BigInt(amount) })
        else if (amount !== '0') strangers++
      }
    const [plain, tokens] = await Promise.all([
      json(fetch, network, 'GET', `/v1/accounts/${account.address}/transactions?limit=20`),
      json(fetch, network, 'GET', `/v1/accounts/${account.address}/transactions/trc20?limit=20`)
    ])
    const activity: Activity[] = []
    for (const t of (plain.data ?? []) as {
      txID: string
      block_timestamp?: number
      ret?: { contractRet?: string }[]
      raw_data?: { contract?: { type?: string; parameter?: { value?: Record<string, unknown> } }[] }
    }[]) {
      const c = t.raw_data?.contract?.[0]
      const v = c?.parameter?.value ?? {}
      const outgoing =
        typeof v.owner_address === 'string' &&
        v.owner_address === hex.encode(addressBytes(account.address)!)
      const amount =
        c?.type === 'TransferContract' && typeof v.amount === 'number' ? BigInt(v.amount) : null
      // token payments are listed with the tokens'
      if (c?.type === 'TriggerSmartContract') continue
      const other = (outgoing ? v.to_address : v.owner_address) as string | undefined
      activity.push({
        id: t.txID,
        kind:
          c?.type === 'TransferContract'
            ? outgoing
              ? 'Sent'
              : 'Received'
            : (c?.type ?? 'Transaction').replace(/Contract$/, ''),
        amount: amount === null ? null : outgoing ? -amount : amount,
        token: null,
        time: t.block_timestamp ? Math.floor(t.block_timestamp / 1000) : null,
        counterparty:
          other && /^41[0-9a-f]{40}$/.test(other) ? addressText(hex.decode(other)) : undefined,
        failed: t.ret?.[0]?.contractRet !== undefined && t.ret[0].contractRet !== 'SUCCESS'
      })
    }
    for (const t of (tokens.data ?? []) as {
      transaction_id: string
      block_timestamp?: number
      from: string
      to: string
      value: string
      token_info?: { address: string; decimals: number; symbol: string }
    }[]) {
      if (!t.token_info || !/^\d+$/.test(t.value)) continue
      if (!KNOWN.some((k) => k.network === network && k.contract === t.token_info!.address))
        continue
      const outgoing = t.from === account.address
      const value = BigInt(t.value)
      activity.push({
        id: t.transaction_id,
        kind: outgoing ? 'Sent' : 'Received',
        amount: outgoing ? -value : value,
        token: tokenOf(network, t.token_info.address, t.token_info.decimals, t.token_info.symbol),
        time: t.block_timestamp ? Math.floor(t.block_timestamp / 1000) : null,
        counterparty: outgoing ? t.to : t.from
      })
    }
    activity.sort((x, y) => (y.time ?? Infinity) - (x.time ?? Infinity))
    return {
      holdings,
      activity,
      reserved: 0n,
      exists: true,
      notes: [
        ...(data
          ? []
          : [
              'Tron hasn’t this account yet: it opens with the first TRX sent to it, which the sender pays for.'
            ]),
        ...(strangers > 0
          ? [
              `It also holds ${strangers} token${strangers === 1 ? '' : 's'} maki doesn’t know. Tron’s accounts are sent tokens unasked, often scams named like real ones: they’re left out here.`
            ]
          : [])
      ]
    }
  },

  async pay(fetch, account, _state, to, amount, token) {
    const network = account.network
    const block = await recentBlock(fetch, network)
    const now = Math.max(Date.now(), block.time)
    let feeLimit: bigint | undefined
    if (token) {
      // the energy the transfer takes, priced as the chain prices it now, with room
      try {
        const [estimate, params] = await Promise.all([
          json(fetch, network, 'POST', '/wallet/triggerconstantcontract', {
            owner_address: account.address,
            contract_address: token.id,
            function_selector: 'transfer(address,uint256)',
            parameter:
              hex.encode(new Uint8Array(12)) +
              hex.encode(addressBytes(to)!.subarray(1)) +
              amount.toString(16).padStart(64, '0'),
            visible: true
          }),
          json(fetch, network, 'POST', '/wallet/getchainparameters')
        ])
        const energy = BigInt((estimate.energy_used as number | undefined) ?? 0)
        const price = BigInt(
          ((params.chainParameter ?? []) as { key: string; value?: number }[]).find(
            (p) => p.key === 'getEnergyFee'
          )?.value ?? 210
        )
        if (energy > 0n) feeLimit = ((energy * price * 13n) / 10n / SUN + 1n) * SUN
      } catch {
        // the cap below
      }
    }
    const payment: TronPayment = {
      refBlockBytes: block.bytes,
      refBlockHash: block.hash,
      timestamp: now,
      expiration: now + VALID_MS,
      owner: account.address,
      to,
      amount,
      token: token?.id,
      feeLimit: token ? (feeLimit ?? FEE_LIMIT_FALLBACK) : undefined
    }
    const raw = rawData(payment)
    return {
      payload: raw,
      fee: token ? payment.feeLimit! : 1_100_000n,
      feeIsMost: true,
      notes: [],
      carry: raw
    }
  },

  async submit(fetch, account, payment, signature) {
    const raw = payment.carry as Uint8Array
    const r = (await json(fetch, account.network, 'POST', '/wallet/broadcasthex', {
      transaction: hex.encode(signedTransaction(raw, signature))
    })) as { result?: boolean; txid?: string; code?: string; message?: string }
    if (!r.result) {
      let why = r.message ?? r.code ?? 'no reason'
      if (/^[0-9a-f]+$/i.test(why) && why.length % 2 === 0)
        why = new TextDecoder().decode(hex.decode(why))
      throw new Error(`the network turned it down: ${why}`)
    }
    return txid(raw)
  }
}
