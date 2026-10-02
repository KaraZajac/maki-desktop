/**
 * Sui, for maki desktop's wallet: the account maki's Sui app shares (Slush's and Ledger Live's, at
 * m/44'/784'/0'/0'/0'), what it holds (SUI and the coins maki knows, in coin objects and in its
 * address balance, SIP-58), what it's done, from Sui's GraphQL API (public fullnodes no longer
 * serve JSON-RPC); and payments made as the SDK makes them and the app takes them to sign: a
 * TransactionData in BCS that splits the gas coin, or merges the account's coins of a kind, or
 * withdraws from its address balance (its fee from there too, the transaction then good for this
 * epoch and the next on this chain only), its budget found by simulating it; then executed with
 * maki's signature.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { blake2b } from '@noble/hashes/blake2.js'
import { base58, base64, hex } from '@scure/base'
import type { AccountChain, Activity, ChainToken, Holding } from '../account-chain'
import type { CoinFetch } from '../coin-servers'

export const SUI_APP = 'com.leviathan.maki.sui'
/** MIST in a SUI. */
export const MIST = 1_000_000_000n
export const SUI_TYPE = '0x2::sui::SUI'

/** Coins maki knows by type (maki-sui's `tokens`): the gasless stablecoins, WAL, DEEP; testnet USDC. */
const KNOWN: { network: 0 | 1; type: string; symbol: string; decimals: number }[] = [
  {
    network: 0,
    type: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    symbol: 'USDC',
    decimals: 6
  },
  {
    network: 0,
    type: '0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI',
    symbol: 'USDSUI',
    decimals: 6
  },
  {
    network: 0,
    type: '0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE',
    symbol: 'suiUSDe',
    decimals: 6
  },
  {
    network: 0,
    type: '0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY',
    symbol: 'USDY',
    decimals: 6
  },
  {
    network: 0,
    type: '0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD',
    symbol: 'FDUSD',
    decimals: 6
  },
  {
    network: 0,
    type: '0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD',
    symbol: 'AUSD',
    decimals: 6
  },
  {
    network: 0,
    type: '0xe14726c336e81b32328e92afc37345d159f5b550b09fa92bd43640cfdd0a0cfd::usdb::USDB',
    symbol: 'USDB',
    decimals: 6
  },
  {
    network: 0,
    type: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
    symbol: 'WAL',
    decimals: 9
  },
  {
    network: 0,
    type: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
    symbol: 'DEEP',
    decimals: 6
  },
  {
    network: 1,
    type: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
    symbol: 'USDC',
    decimals: 6
  }
]

/** An address (or object ID) in full: 0x and 64 hex digits, `0x2` filled out. */
export function normalize(address: string): string | null {
  const m = /^0x([0-9a-fA-F]{1,64})$/.exec(address)
  return m ? `0x${m[1].toLowerCase().padStart(64, '0')}` : null
}

/** A coin type in full (its package's address filled out), as the API writes it. */
export function fullType(type: string): string {
  const [address, ...rest] = type.split('::')
  return [normalize(address) ?? address, ...rest].join('::')
}

function tokenOf(network: 0 | 1, type: string): ChainToken | null {
  const k = KNOWN.find((k) => k.network === network && fullType(k.type) === fullType(type))
  return k ? { id: fullType(k.type), symbol: k.symbol, decimals: k.decimals } : null
}

// ---- TransactionData, in BCS ----

/** An object as a transaction names it: its ID, version and digest. */
export interface ObjectRef {
  id: string
  version: bigint
  digest: Uint8Array
}

export type SuiInput =
  { pure: Uint8Array } | { owned: ObjectRef } | { withdraw: { amount: bigint; type: string } }

export type SuiArgument =
  'gas' | { input: number } | { result: number } | { nested: [number, number] }

export type SuiCommand =
  | { call: { target: string; types: string[]; args: SuiArgument[] } }
  | { transfer: { objects: SuiArgument[]; to: SuiArgument } }
  | { split: { coin: SuiArgument; amounts: SuiArgument[] } }
  | { merge: { into: SuiArgument; coins: SuiArgument[] } }

export interface SuiTransaction {
  sender: string
  inputs: SuiInput[]
  commands: SuiCommand[]
  payment: ObjectRef[]
  price: bigint
  budget: bigint
  /** none, or good in these two epochs on this chain only (with no gas coin, Sui wants that) */
  expiration: null | { min: bigint; max: bigint; chain: Uint8Array; nonce: number }
}

class Bcs {
  private out: number[] = []
  uleb(n: number): this {
    do {
      const b = n & 0x7f
      n = Math.floor(n / 128)
      this.out.push(n > 0 ? b | 0x80 : b)
    } while (n > 0)
    return this
  }
  u8(n: number): this {
    this.out.push(n & 0xff)
    return this
  }
  int(n: bigint, bytes: number): this {
    for (let i = 0n; i < BigInt(bytes); i++) this.out.push(Number((n >> (8n * i)) & 0xffn))
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
  address(a: string): this {
    const n = normalize(a)
    if (!n) throw new Error(`not a Sui address: ${a}`)
    return this.fixed(hex.decode(n.slice(2)))
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

/** A struct's type (`0x2::sui::SUI`, no type arguments) as a TypeTag. */
function structTag(w: Bcs, type: string): void {
  const [address, module, name] = type.split('::')
  if (!module || !name || name.includes('<'))
    throw new Error(`not a coin type maki desktop writes: ${type}`)
  w.uleb(7).address(address).str(module).str(name).uleb(0)
}

function argument(w: Bcs, a: SuiArgument): void {
  if (a === 'gas') w.uleb(0)
  else if ('input' in a) w.uleb(1).int(BigInt(a.input), 2)
  else if ('result' in a) w.uleb(2).int(BigInt(a.result), 2)
  else w.uleb(3).int(BigInt(a.nested[0]), 2).int(BigInt(a.nested[1]), 2)
}

function objectRef(w: Bcs, o: ObjectRef): void {
  w.address(o.id).int(o.version, 8).bytes(o.digest)
}

/** The transaction's bytes: what maki's app signs (after Sui's intent, which it adds itself). */
export function transactionData(tx: SuiTransaction): Uint8Array {
  // TransactionData::V1, a programmable transaction
  const w = new Bcs().uleb(0).uleb(0).uleb(tx.inputs.length)
  for (const i of tx.inputs) {
    if ('pure' in i) w.uleb(0).bytes(i.pure)
    else if ('owned' in i) {
      w.uleb(1).uleb(0)
      objectRef(w, i.owned)
    } else {
      // a withdrawal from the sender's address balance: at most this much, of this coin
      w.uleb(2).uleb(0).int(i.withdraw.amount, 8).uleb(0)
      structTag(w, i.withdraw.type)
      w.uleb(0)
    }
  }
  w.uleb(tx.commands.length)
  for (const c of tx.commands) {
    if ('call' in c) {
      const [pkg, module, fn] = c.call.target.split('::')
      w.uleb(0).address(pkg).str(module).str(fn).uleb(c.call.types.length)
      for (const t of c.call.types) structTag(w, t)
      w.uleb(c.call.args.length)
      for (const a of c.call.args) argument(w, a)
    } else if ('transfer' in c) {
      w.uleb(1).uleb(c.transfer.objects.length)
      for (const a of c.transfer.objects) argument(w, a)
      argument(w, c.transfer.to)
    } else if ('split' in c) {
      w.uleb(2)
      argument(w, c.split.coin)
      w.uleb(c.split.amounts.length)
      for (const a of c.split.amounts) argument(w, a)
    } else {
      w.uleb(3)
      argument(w, c.merge.into)
      w.uleb(c.merge.coins.length)
      for (const a of c.merge.coins) argument(w, a)
    }
  }
  w.address(tx.sender).uleb(tx.payment.length)
  for (const o of tx.payment) objectRef(w, o)
  w.address(tx.sender).int(tx.price, 8).int(tx.budget, 8)
  if (!tx.expiration) return w.uleb(0).finish()
  const e = tx.expiration
  return w
    .uleb(2)
    .u8(1)
    .int(e.min, 8)
    .u8(1)
    .int(e.max, 8)
    .u8(0)
    .u8(0)
    .bytes(e.chain)
    .int(BigInt(e.nonce), 4)
    .finish()
}

/** A transaction's digest, as Sui and its explorers show it. */
export const transactionDigest = (data: Uint8Array): string =>
  base58.encode(
    blake2b(Uint8Array.from([...new TextEncoder().encode('TransactionData::'), ...data]), {
      dkLen: 32
    })
  )

const u64 = (n: bigint): Uint8Array => new Bcs().int(n, 8).finish()
const addressBytes = (a: string): Uint8Array => hex.decode(normalize(a)!.slice(2))

/**
 * A send from coin objects: SUI by splitting the gas coin; another coin by merging the account's of
 * it, splitting off the amount, and sending it with a call that names its type (so maki can say what
 * it is), into the recipient's address balance, as the SDK does.
 */
export function fromCoins(
  to: string,
  amount: bigint,
  coins: ObjectRef[] | null,
  type = SUI_TYPE
): Pick<SuiTransaction, 'inputs' | 'commands'> {
  if (!coins)
    return {
      inputs: [{ pure: u64(amount) }, { pure: addressBytes(to) }],
      commands: [
        { split: { coin: 'gas', amounts: [{ input: 0 }] } },
        { transfer: { objects: [{ result: 0 }], to: { input: 1 } } }
      ]
    }
  const n = coins.length
  return {
    inputs: [
      ...coins.map((owned) => ({ owned })),
      { pure: u64(amount) },
      { pure: addressBytes(to) }
    ],
    commands: [
      ...(n > 1
        ? [
            {
              merge: { into: { input: 0 }, coins: coins.slice(1).map((_, i) => ({ input: i + 1 })) }
            } as SuiCommand
          ]
        : []),
      { split: { coin: { input: 0 }, amounts: [{ input: n }] } },
      {
        call: {
          target: '0x2::coin::send_funds',
          types: [type],
          args: [{ nested: [n > 1 ? 1 : 0, 0] }, { input: n + 1 }]
        }
      }
    ]
  }
}

/** A send from the address balance, as the SDK's `tx.coin()` makes it: withdraw, split, the rest back. */
export function fromBalance(
  sender: string,
  to: string,
  amount: bigint,
  type = SUI_TYPE
): Pick<SuiTransaction, 'inputs' | 'commands'> {
  return {
    inputs: [
      { pure: addressBytes(to) },
      { withdraw: { amount, type } },
      { pure: u64(amount) },
      { pure: addressBytes(sender) }
    ],
    commands: [
      { call: { target: '0x2::coin::redeem_funds', types: [type], args: [{ input: 1 }] } },
      { split: { coin: { result: 0 }, amounts: [{ input: 2 }] } },
      {
        call: {
          target: '0x2::coin::send_funds',
          types: [type],
          args: [{ result: 0 }, { input: 3 }]
        }
      },
      { transfer: { objects: [{ nested: [1, 0] }], to: { input: 0 } } }
    ]
  }
}

// ---- Sui's GraphQL API ----

async function graphql<T>(
  fetch: CoinFetch,
  network: 0 | 1,
  query: string,
  variables: object
): Promise<T> {
  const r = await fetch(network, 'POST', '/graphql', JSON.stringify({ query, variables }))
  const body = JSON.parse(r.text) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length || !body.data)
    throw new Error(body.errors?.[0]?.message ?? `Sui's API answered ${r.status}`)
  return body.data
}

interface Balance {
  coinType: { repr: string }
  totalBalance: string
  coinBalance: string
  addressBalance: string
}

const BALANCES = `query($a: SuiAddress!) { address(address: $a) { balances(first: 50) { nodes { coinType { repr } totalBalance coinBalance addressBalance } } } }`
const COINS = `query($a: SuiAddress!, $t: String!) { address(address: $a) { objects(filter: {type: $t}, first: 50) { nodes { address version digest contents { json } } } } }`
const NOW = `{ epoch { epochId referenceGasPrice } chainIdentifier }`
const HISTORY = `query($a: SuiAddress!) { transactions(last: 20, filter: {affectedAddress: $a}) { nodes { digest effects { status timestamp balanceChanges { nodes { owner { address } amount coinType { repr } } } } } } }`
const SIMULATE = `query($t: JSON!) { simulateTransaction(transaction: $t) { effects { status executionError { message } gasEffects { gasSummary { computationCost storageCost storageRebate } } } } }`
const EXECUTE = `mutation($t: Base64!, $s: [Base64!]!) { executeTransaction(transactionDataBcs: $t, signatures: $s) { effects { status digest executionError { message } } } }`

async function balances(fetch: CoinFetch, network: 0 | 1, address: string): Promise<Balance[]> {
  const d = await graphql<{ address: { balances: { nodes: Balance[] } } | null }>(
    fetch,
    network,
    BALANCES,
    { a: address }
  )
  return d.address?.balances.nodes ?? []
}

/** The account's coin objects of a type, the largest first, with their balances. */
async function coinsOf(
  fetch: CoinFetch,
  network: 0 | 1,
  address: string,
  type: string
): Promise<(ObjectRef & { balance: bigint })[]> {
  const d = await graphql<{
    address: {
      objects: {
        nodes: {
          address: string
          version: number
          digest: string
          contents: { json: { balance?: string } }
        }[]
      }
    } | null
  }>(fetch, network, COINS, { a: address, t: `0x2::coin::Coin<${type}>` })
  return (d.address?.objects.nodes ?? [])
    .map((o) => ({
      id: o.address,
      version: BigInt(o.version),
      digest: base58.decode(o.digest),
      balance: BigInt(o.contents.json.balance ?? 0)
    }))
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
}

export const SUI: AccountChain = {
  id: 'sui',
  name: 'Sui',
  app: SUI_APP,
  glyph: 'sui',
  tint: 'bg-sky/10 text-sky',
  units: ['SUI', 'tSUI'],
  decimals: 9,
  priced: 'SUI',
  networks: ['Sui', 'Testnet'],
  hint: '0x…',
  memo: null,
  wallets: 'The account Slush and Ledger make',
  servers:
    'Balances and payments go through Sui’s GraphQL API (Mysten Labs’), which sees the account’s address and this computer’s IP address.',
  explorerName: 'Suiscan',
  explorer: (network, kind, id) =>
    `https://suiscan.xyz/${network === 0 ? 'mainnet' : 'testnet'}/${kind === 'tx' ? 'tx' : 'account'}/${id}`,
  uri: (address) => address,
  valid: (address) => /^0x[0-9a-fA-F]{64}$/.test(address),

  async look(fetch, account) {
    const network = account.network
    const all = await balances(fetch, network, account.address)
    const sui = all.find((b) => fullType(b.coinType.repr) === fullType(SUI_TYPE))
    const holdings: Holding[] = [{ token: null, amount: BigInt(sui?.totalBalance ?? 0) }]
    let strangers = 0
    for (const b of all) {
      if (b === sui || b.totalBalance === '0') continue
      const token = tokenOf(network, b.coinType.repr)
      if (token) holdings.push({ token, amount: BigInt(b.totalBalance) })
      else strangers++
    }
    const notes: string[] = []
    if (strangers > 0)
      notes.push(
        `It also holds ${strangers} coin${strangers === 1 ? '' : 's'} maki doesn’t know (Sui’s accounts are sent coins unasked, often scams named like real ones): they aren’t shown.`
      )
    const activity: Activity[] = []
    try {
      const d = await graphql<{
        transactions: {
          nodes: {
            digest: string
            effects: {
              status: string
              timestamp: string | null
              balanceChanges: {
                nodes: {
                  owner: { address: string } | null
                  amount: string
                  coinType: { repr: string }
                }[]
              }
            }
          }[]
        }
      }>(fetch, network, HISTORY, { a: account.address })
      for (const t of [...d.transactions.nodes].reverse()) {
        const mine = t.effects.balanceChanges.nodes.filter(
          (c) => c.owner?.address === normalize(account.address)
        )
        const main =
          mine.find(
            (c) =>
              fullType(c.coinType.repr) !== fullType(SUI_TYPE) && tokenOf(network, c.coinType.repr)
          ) ?? mine.find((c) => fullType(c.coinType.repr) === fullType(SUI_TYPE))
        const amount = main ? BigInt(main.amount) : null
        const token =
          main && fullType(main.coinType.repr) !== fullType(SUI_TYPE)
            ? tokenOf(network, main.coinType.repr)
            : null
        activity.push({
          id: t.digest,
          kind: amount === null ? 'Transaction' : amount < 0n ? 'Sent' : 'Received',
          amount,
          token,
          time: t.effects.timestamp ? Math.floor(Date.parse(t.effects.timestamp) / 1000) : null,
          failed: t.effects.status !== 'SUCCESS'
        })
      }
    } catch {
      notes.push('Sui’s API couldn’t be asked for the account’s history just now.')
    }
    return { holdings, activity, reserved: 0n, exists: true, notes }
  },

  async pay(fetch, account, _state, to, amount, token) {
    const network = account.network
    const recipient = normalize(to)
    if (!recipient || to.length !== 66)
      throw new Error('that isn’t a Sui address (0x and 64 hex digits)')
    const type = token ? token.id : SUI_TYPE
    const [now, all, gasCoins] = await Promise.all([
      graphql<{ epoch: { epochId: number; referenceGasPrice: string }; chainIdentifier: string }>(
        fetch,
        network,
        NOW,
        {}
      ),
      balances(fetch, network, account.address),
      coinsOf(fetch, network, account.address, SUI_TYPE)
    ])
    const price = BigInt(now.epoch.referenceGasPrice)
    const held = all.find((b) => fullType(b.coinType.repr) === fullType(type))
    const suiHeld = all.find((b) => fullType(b.coinType.repr) === fullType(SUI_TYPE))
    const coinSui = gasCoins.reduce((s, c) => s + c.balance, 0n)
    const balanceSui = BigInt(suiHeld?.addressBalance ?? 0)
    // where it comes from: the account's coins of it if they hold it, else its address balance
    let parts: Pick<SuiTransaction, 'inputs' | 'commands'>
    let payment: ObjectRef[] = []
    if (!token) {
      if (coinSui > amount && gasCoins.length > 0) {
        parts = fromCoins(recipient, amount, null)
        payment = gasCoins.slice(0, 200)
      } else if (balanceSui > amount) parts = fromBalance(account.address, recipient, amount)
      else
        throw new Error(
          'not enough SUI in one place for that: its coins and its address balance are each short'
        )
    } else {
      const coins = await coinsOf(fetch, network, account.address, type)
      const inCoins = coins.reduce((s, c) => s + c.balance, 0n)
      if (inCoins >= amount) parts = fromCoins(recipient, amount, coins.slice(0, 100), type)
      else if (BigInt(held?.addressBalance ?? 0) >= amount)
        parts = fromBalance(account.address, recipient, amount, type)
      else throw new Error(`not enough ${token.symbol ?? 'of it'} in one place for that`)
      if (gasCoins.length > 0 && coinSui > 0n) payment = gasCoins.slice(0, 200)
    }
    // with no gas coin, the fee comes from the address balance, and the transaction is good on this
    // chain in this epoch and the next only
    const epoch = BigInt(now.epoch.epochId)
    const tx: SuiTransaction = {
      sender: account.address,
      ...parts,
      payment,
      price,
      budget: 50_000_000n,
      expiration:
        payment.length > 0
          ? null
          : {
              min: epoch,
              max: epoch + 1n,
              chain: base58.decode(now.chainIdentifier),
              nonce: Math.floor(Math.random() * 2 ** 32)
            }
    }
    const sim = await graphql<{
      simulateTransaction: {
        effects: {
          status: string
          executionError: { message: string } | null
          gasEffects: {
            gasSummary: { computationCost: string; storageCost: string; storageRebate: string }
          }
        }
      }
    }>(fetch, network, SIMULATE, { t: { bcs: { value: base64.encode(transactionData(tx)) } } })
    const e = sim.simulateTransaction.effects
    if (e.status !== 'SUCCESS')
      throw new Error(`Sui would turn it down: ${e.executionError?.message ?? e.status}`)
    const g = e.gasEffects.gasSummary
    const cost = BigInt(g.computationCost) + BigInt(g.storageCost)
    // room over what it took, never less than the least Sui takes
    tx.budget = (cost * 3n) / 2n > price * 1000n ? (cost * 3n) / 2n : price * 1000n
    // the most the fee can be, and the SUI it comes out of: the gas coins', or the address balance's
    const spendsSui = token ? 0n : amount
    if ((payment.length > 0 ? coinSui : balanceSui) < spendsSui + tx.budget)
      throw new Error('not enough SUI for that and the fee')
    const payload = transactionData(tx)
    const notes: string[] = []
    if (payment.length === 0)
      notes.push('This comes from the account’s address balance, its fee too.')
    return { payload, fee: tx.budget, feeIsMost: true, notes, carry: payload }
  },

  async submit(fetch, account, payment, signature) {
    if (signature.length !== 64)
      throw new Error('maki’s Sui app gave a signature maki desktop can’t read')
    const data = payment.carry as Uint8Array
    const key = hex.decode(account.publicKey)
    const d = await graphql<{
      executeTransaction: {
        effects: {
          status: string
          digest: string
          executionError: { message: string } | null
        } | null
      }
    }>(fetch, account.network, EXECUTE, {
      t: base64.encode(data),
      s: [base64.encode(Uint8Array.from([0, ...signature, ...key]))]
    })
    const e = d.executeTransaction.effects
    if (!e || e.status !== 'SUCCESS')
      throw new Error(
        `the network turned it down: ${e?.executionError?.message ?? e?.status ?? 'no answer'}`
      )
    if (e.digest !== transactionDigest(data))
      throw new Error('Sui’s API took a different transaction from the one maki signed')
    return e.digest
  }
}
