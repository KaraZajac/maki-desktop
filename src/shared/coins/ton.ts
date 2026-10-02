/**
 * TON, for maki desktop's wallet: the account maki's TON app shares (its Ed25519 key at
 * m/44'/607'/network'/0'/0'/0', as Ledger's TON app, Ledger Live and Tonkeeper with a Ledger have
 * it), in the two wallet contracts maki knows, each at an address of its own: v4R2 (the one Ledger
 * Live shows) and W5 (v5R1, today's wallets' first choice). What each holds (TON, and the jettons
 * maki knows, USDT, NOT and DOGS, when their jetton wallets are provably the account's own) and what
 * it's done come from toncenter, TON's own API. A payment is the cell the wallet's key signs, as
 * @ton/ton makes it (its messages as @ton/core's `internal()` writes them, sent with mode 3: the
 * forwarding fee paid on top, errors skipped), in a BOC; maki's app reads it, shows it and signs its
 * hash; the signature goes before the cell (v4R2) or after it (W5), in an external message to the
 * wallet, with the wallet's first state when it's the wallet's first.
 *
 * TON takes its fee from the wallet's balance when the payment runs, at its prices then: nothing
 * signed bounds it, so the fee here is toncenter's estimate, said as such.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { base64, hex } from '@scure/base'
import type { AccountChain, Activity, ChainState, ChainToken, Holding } from '../account-chain'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import { units } from '../tokens'
import { TON_APP } from '../wallet-apps'
import {
  Builder,
  Cell,
  friendly,
  fromRaw,
  rawAddress,
  readAddress,
  readBoc,
  sameAddress,
  snake,
  type TonAddress,
  writeBoc
} from './ton-cells'

/** Nanotons in a TON. */
export const NANO = 1_000_000_000n
/** A wallet contract maki knows, by its name in maki's messages. */
export type TonWallet = 'v4R2' | 'v5R1'
/** Its name as wallets show it. */
export const WALLET_NAME: Record<TonWallet, string> = { v4R2: 'v4R2', v5R1: 'W5' }

/**
 * The wallets' code, compiled, as @ton/ton 16.3.0 holds it (its WalletContractV4 and
 * WalletContractV5R1; MIT, Whales Corp.): v4R2's from ton-blockchain/wallet-contract's
 * `func/wallet-v4-code.fc` (MIT, TON Core; the repository at 68b56dc0), W5's from
 * ton-blockchain/wallet-contract-v5 (MIT, Tonkeeper; the same bytes as its
 * `build/wallet_v5.compiled.json` at ff2a9cdb). Each is held to its hash below, as maki's app has it.
 */
const CODE_BOC: Record<TonWallet, string> = {
  v4R2: 'te6cckECFAEAAtQAART/APSkE/S88sgLAQIBIAIPAgFIAwYC5tAB0NMDIXGwkl8E4CLXScEgkl8E4ALTHyGCEHBsdWe9IoIQZHN0cr2wkl8F4AP6QDAg+kQByMoHy//J0O1E0IEBQNch9AQwXIEBCPQKb6Exs5JfB+AF0z/IJYIQcGx1Z7qSODDjDQOCEGRzdHK6kl8G4w0EBQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAHDgIBIAgNAgFYCQoAPbKd+1E0IEBQNch9AQwAsjKB8v/ydABgQEI9ApvoTGACASALDAAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwAARuMl+1E0NcLH4AFm9JCtvaiaECAoGuQ+gIYRw1AgIR6STfSmRDOaQPp/5g3gSgBt4EBSJhxWfMYQE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVAj45Sg=',
  v5R1: 'te6cckECFAEAAoEAART/APSkE/S88sgLAQIBIAINAgFIAwQC3NAg10nBIJFbj2Mg1wsfIIIQZXh0br0hghBzaW50vbCSXwPgghBleHRuuo60gCDXIQHQdNch+kAw+kT4KPpEMFi9kVvg7UTQgQFB1yH0BYMH9A5voTGRMOGAQNchcH/bPOAxINdJgQKAuZEw4HDiEA8CASAFDAIBIAYJAgFuBwgAGa3OdqJoQCDrkOuF/8AAGa8d9qJoQBDrkOuFj8ACAUgKCwAXsyX7UTQcdch1wsfgABGyYvtRNDXCgCAAGb5fD2omhAgKDrkPoCwBAvIOAR4g1wsfghBzaWduuvLgin8PAeaO8O2i7fshgwjXIgKDCNcjIIAg1yHTH9Mf0x/tRNDSANMfINMf0//XCgAK+QFAzPkQmiiUXwrbMeHywIffArNQB7Dy0IRRJbry4IVQNrry4Ib4I7vy0IgikvgA3gGkf8jKAMsfAc8Wye1UIJL4D95w2zzYEAP27aLt+wL0BCFukmwhjkwCIdc5MHCUIccAs44tAdcoIHYeQ2wg10nACPLgkyDXSsAC8uCTINcdBscSwgBSMLDy0InXTNc5MAGk6GwShAe78uCT10rAAPLgk+1V4tIAAcAAkVvg69csCBQgkXCWAdcsCBwS4lIQseMPINdKERITAJYB+kAB+kT4KPpEMFi68uCR7UTQgQFB1xj0BQSdf8jKAEAEgwf0U/Lgi44UA4MH9Fvy4Iwi1woAIW4Bs7Dy0JDiyFADzxYS9ADJ7VQAcjDXLAgkji0h8uCS0gDtRNDSAFETuvLQj1RQMJExnAGBAUDXIdcKAPLgjuLIygBYzxbJ7VST8sCN4gAQk1vbMeHXTNC01sNe'
}
/** Their code's hash: what names their addresses, as maki's app has them (maki-ton's `wallet`). */
const CODE_HASH: Record<TonWallet, string> = {
  v4R2: 'feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0',
  v5R1: '20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f'
}
const codes = new Map<TonWallet, Cell>()
/** A wallet's code, read from its BOC once, and held to its hash. */
export function walletCode(wallet: TonWallet): Cell {
  let c = codes.get(wallet)
  if (!c) {
    c = readBoc(base64.decode(CODE_BOC[wallet]))
    if (hex.encode(c.hash()) !== CODE_HASH[wallet]) throw new Error(`not ${wallet}'s code`)
    codes.set(wallet, c)
  }
  return c
}

/** Each network's global ID (its configuration's parameter 19), which W5's wallet ID mixes in. */
const GLOBAL_ID = [-239, -3]
/** v4R2's subwallet, every wallet's first. */
export const V4R2_SUBWALLET = 698_983_191

/**
 * The wallet ID a wallet is made with: v4R2's subwallet, or W5's (the network's global ID XOR its
 * context: a 1, workchain 0, version 0, subwallet 0), as an unsigned 32-bit number.
 */
export function walletId(wallet: TonWallet, network: 0 | 1): number {
  return wallet === 'v4R2' ? V4R2_SUBWALLET : (GLOBAL_ID[network] ^ 0x80000000) >>> 0
}

/** A wallet's first data: v4R2's seqno, subwallet, key and no plugins; W5's flag, seqno, ID, key, no extensions. */
export function walletData(wallet: TonWallet, key: Uint8Array, network: 0 | 1): Cell {
  const b = new Builder()
  if (wallet === 'v5R1') b.bit(1)
  return b.uint(0, 32).uint(walletId(wallet, network), 32).bytes(key).bit(0).cell()
}

/** A contract's first state (`StateInit`): no split depth, not tick-tock, its code and data, no libraries. */
export function stateInit(code: Cell, data: Cell): Cell {
  return new Builder().bit(0).bit(0).maybeRef(code).maybeRef(data).bit(0).cell()
}

/** The wallet's first state, with `key`, on `network`. */
export const walletInit = (wallet: TonWallet, key: Uint8Array, network: 0 | 1): Cell =>
  stateInit(walletCode(wallet), walletData(wallet, key, network))

/** The wallet's address: on the basechain, the hash of its first state. */
export function walletAddress(wallet: TonWallet, key: Uint8Array, network: 0 | 1): TonAddress {
  return { workchain: 0, hash: walletInit(wallet, key, network).hash() }
}

/** Its address as wallets show their own: non-bounceable, flagged on the test network. */
export const shownAddress = (wallet: TonWallet, key: Uint8Array, network: 0 | 1): string =>
  friendly(walletAddress(wallet, key, network), false, network === 1)

// ---- jettons ----

/** A jetton maki knows (maki-ton's `jettons`): by its master, its wallets' code, its decimals. */
export interface Jetton {
  symbol: string
  decimals: number
  master: TonAddress
  /** the hash of the code its jetton wallets run, which the master holds as a library cell */
  code: string
}
const jetton = (symbol: string, decimals: number, master: string, code: string): Jetton => ({
  symbol,
  decimals,
  master: readAddress(master)!.address,
  code
})
/** Tether's USD₮, Notcoin and DOGS: on TON alone (its test network has none of them). */
export const JETTONS: Jetton[] = [
  jetton(
    'USDT',
    6,
    'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    '8f452d7a4dfd74066b682365177259ed05734435be76b5fd4bd5d8af2b7c3d68'
  ),
  jetton(
    'NOT',
    9,
    'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT',
    'ba2918c8947e9b25af9ac1b883357754173e5812f807a3d6e642a14709595395'
  ),
  jetton(
    'DOGS',
    9,
    'EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS',
    'ba2918c8947e9b25af9ac1b883357754173e5812f807a3d6e642a14709595395'
  )
]

/**
 * `owner`'s jetton wallet for `j`, as its master works it out: the hash of its first state (the
 * library cell for its code; status 0, balance 0, the owner and the master).
 */
export function jettonWallet(j: Jetton, owner: TonAddress): TonAddress {
  const code = new Builder().uint(2, 8).bytes(hex.decode(j.code)).cell(true)
  const data = new Builder().uint(0, 4).coins(0n).address(owner).address(j.master).cell()
  return { workchain: 0, hash: stateInit(code, data).hash() }
}

/** A jetton as the wallet's holdings name it: its master, as wallets show a contract. */
const tokenOf = (j: Jetton): ChainToken => ({
  id: friendly(j.master, true, false),
  symbol: j.symbol,
  decimals: j.decimals
})

// ---- what a wallet sends ----

/** A comment (TEP-74): op 0, then the text as TON writes text. */
export function comment(text: string): Cell {
  return snake(new Builder().uint(0, 32), new TextEncoder().encode(text)).cell()
}

/** The TON a jetton transfer takes to its jetton wallet for the fees: what isn't used comes back. */
export const JETTON_TON = 50_000_000n
/** What goes on to the recipient with jettons, so their wallet hears of them (and of the comment). */
const FORWARD_TON = 1n

/**
 * TEP-74's transfer, as wallets write it: query 0, the amount, whose jettons they become, what's
 * left back to this wallet, no custom payload, a nanoton on with the comment (in a reference) or
 * without one.
 */
export function jettonTransfer(t: {
  amount: bigint
  to: TonAddress
  response: TonAddress
  comment: string
}): Cell {
  const b = new Builder()
    .uint(0x0f8a7ea5, 32)
    .uint(0n, 64)
    .coins(t.amount)
    .address(t.to)
    .address(t.response)
    .bit(0)
    .coins(FORWARD_TON)
  return (t.comment ? b.bit(1).ref(comment(t.comment)) : b.bit(0)).cell()
}

/**
 * A message the wallet sends (`MessageRelaxed`), as @ton/core's `internal()` writes it: no sender
 * named, no extra currencies, those fields zero, the body in this cell if it fits, else referred to.
 */
export function internalMessage(m: {
  to: TonAddress
  value: bigint
  bounce: boolean
  body: Cell
}): Cell {
  const b = new Builder()
    .bit(0)
    .bit(1)
    .bit(m.bounce)
    .bit(0)
    .address(null)
    .address(m.to)
    .coins(m.value)
    .bit(0)
    .coins(0n)
    .coins(0n)
    .uint(0n, 64)
    .uint(0, 32)
    .bit(0)
  const inline =
    b.availableBits - 1 >= m.body.bits && b.refCount + m.body.refs.length <= 4 && !m.body.exotic
  return (inline ? b.bit(0).append(m.body) : b.bit(1).ref(m.body)).cell()
}

/** Send mode 3: the forwarding fee paid on top, and errors skipped (W5 refuses a request without). */
export const SEND_MODE = 3

/**
 * The cell a wallet's key signs, as @ton/ton makes it: v4R2's (its subwallet, valid until, seqno,
 * op 0, each message after its mode) or W5's (`sign`, its wallet ID, valid until, seqno, the
 * messages as an out list, no other actions).
 */
export function signingCell(
  wallet: TonWallet,
  r: { walletId: number; validUntil: number; seqno: number; messages: Cell[] }
): Cell {
  if (wallet === 'v4R2') {
    const b = new Builder().uint(r.walletId, 32).uint(r.validUntil, 32).uint(r.seqno, 32).uint(0, 8)
    for (const m of r.messages) b.uint(SEND_MODE, 8).ref(m)
    return b.cell()
  }
  // the out list: each action a cell referring to the one before, the first to an empty one
  let list = Cell.EMPTY
  for (const m of r.messages)
    list = new Builder().ref(list).uint(0x0ec3c86d, 32).uint(SEND_MODE, 8).ref(m).cell()
  return new Builder()
    .uint(0x7369676e, 32)
    .uint(r.walletId, 32)
    .uint(r.validUntil, 32)
    .uint(r.seqno, 32)
    .maybeRef(r.messages.length ? list : null)
    .bit(0)
    .cell()
}

/** What the wallet takes: the signature before the request (v4R2), or after it (W5). */
export function signedBody(wallet: TonWallet, signing: Cell, signature: Uint8Array): Cell {
  return (
    wallet === 'v4R2'
      ? new Builder().bytes(signature).append(signing)
      : new Builder().append(signing).bytes(signature)
  ).cell()
}

/**
 * An external message to the wallet, as @ton/core's `storeMessage(external(…))` writes it: from no
 * one, no import fee, the wallet's first state when it's being set up, then the body, each in this
 * cell if it fits.
 */
export function externalMessage(to: TonAddress, init: Cell | null, body: Cell): Cell {
  const b = new Builder().uint(2, 2).address(null).address(to).coins(0n)
  if (init) {
    b.bit(1)
    if (b.availableBits - 2 < init.bits + body.bits) b.bit(1).ref(init)
    else b.bit(0).append(init)
  } else b.bit(0)
  if (b.availableBits - 1 < body.bits || b.refCount + body.refs.length > 4) b.bit(1).ref(body)
  else b.bit(0).append(body)
  return b.cell()
}

/**
 * An external message's normalized hash (TEP-467): from no one, no import fee, no first state, the
 * body referred to. toncenter finds the transaction it started by it.
 */
export function normalizedHash(to: TonAddress, body: Cell): Uint8Array {
  return new Builder()
    .uint(2, 2)
    .address(null)
    .address(to)
    .coins(0n)
    .bit(0)
    .bit(1)
    .ref(body)
    .cell()
    .hash()
}

// ---- toncenter ----

const ton = (nano: bigint): string => `${units(nano, 9)} TON`

async function call(
  fetch: CoinFetch,
  network: 0 | 1,
  method: 'GET' | 'POST',
  path: string,
  body?: object
): Promise<unknown> {
  const r = await fetch(network, method, path, body && JSON.stringify(body))
  let json: unknown
  try {
    json = JSON.parse(r.text)
  } catch {
    throw new Error(`toncenter answered ${r.status}`)
  }
  if (r.status !== 200) {
    const said = (json as { error?: unknown }).error
    throw new Error(`toncenter: ${typeof said === 'string' ? said : `answered ${r.status}`}`)
  }
  return json
}

const digits = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^\d{1,40}$/.test(v))
    throw new Error('toncenter sent an amount that isn’t one')
  return BigInt(v)
}

/** A wallet as toncenter knows it. */
export interface WalletInfo {
  balance: bigint
  /** `uninit` before its first payment (or `nonexist`, never seen); `frozen` for unpaid storage */
  status: 'active' | 'uninit' | 'nonexist' | 'frozen'
  seqno: number
  /** for an active wallet: its contract, as toncenter names it, and its wallet ID */
  type: string | null
  id: number | null
}

const WALLET_TYPE: Record<TonWallet, string> = { v4R2: 'wallet v4 r2', v5R1: 'wallet v5 r1' }

/** toncenter's `walletInformation` for `address`, checked. */
export async function walletInfo(
  fetch: CoinFetch,
  network: 0 | 1,
  address: string
): Promise<WalletInfo> {
  const w = (await call(
    fetch,
    network,
    'GET',
    `/walletInformation?address=${address}&use_v2=false`
  )) as Record<string, unknown>
  const status = w.status
  if (status !== 'active' && status !== 'uninit' && status !== 'nonexist' && status !== 'frozen')
    throw new Error('toncenter sent a wallet maki desktop can’t read')
  const balance = digits(w.balance ?? '0')
  if (status !== 'active') return { balance, status, seqno: 0, type: null, id: null }
  if (
    typeof w.seqno !== 'number' ||
    !Number.isSafeInteger(w.seqno) ||
    w.seqno < 0 ||
    typeof w.wallet_type !== 'string'
  )
    throw new Error('toncenter sent a wallet maki desktop can’t read')
  return {
    balance,
    status,
    seqno: w.seqno,
    type: w.wallet_type,
    id: typeof w.wallet_id === 'number' ? w.wallet_id >>> 0 : null
  }
}

/** What maki shared: its 32-byte key. */
export function accountKey(account: SharedAccount): Uint8Array {
  const key = hex.decode(account.publicKey)
  if (key.length !== 32) throw new Error('not a TON account maki shared')
  return key
}

/** The account's W5 wallet, beside the v4R2 one maki shared: the same key, its own address. */
export function w5Account(account: SharedAccount): SharedAccount {
  return { ...account, address: shownAddress('v5R1', accountKey(account), account.network) }
}

/** Whether a wallet has ever been used, or holds anything: worth showing. */
export async function walletUsed(fetch: CoinFetch, account: SharedAccount): Promise<boolean> {
  const w = await walletInfo(fetch, account.network, account.address)
  return w.status !== 'uninit' && w.status !== 'nonexist' ? true : w.balance > 0n
}

interface JettonWallets {
  holdings: Holding[]
  /** jetton wallets of the account's that aren't ones maki knows */
  others: number
}

/** The account's jettons maki knows, each from its own jetton wallet; and how many others it has. */
async function jettonsOf(
  fetch: CoinFetch,
  network: 0 | 1,
  address: string,
  mine: TonAddress
): Promise<JettonWallets> {
  const r = (await call(
    fetch,
    network,
    'GET',
    `/jetton/wallets?owner_address=${address}&limit=50&offset=0`
  )) as { jetton_wallets?: unknown }
  if (!Array.isArray(r.jetton_wallets))
    throw new Error('toncenter sent jettons maki desktop can’t read')
  const holdings: Holding[] = []
  let others = 0
  for (const w of r.jetton_wallets as Record<string, unknown>[]) {
    const at = fromRaw(w.address)
    const owner = fromRaw(w.owner)
    const master = fromRaw(w.jetton)
    if (!at || !owner || !master || !sameAddress(owner, mine)) continue
    const balance = digits(w.balance)
    if (balance === 0n) continue
    // a jetton maki knows only where its wallet is the one its master makes for this account
    const j =
      network === 0
        ? JETTONS.find(
            (j) => sameAddress(j.master, master) && sameAddress(jettonWallet(j, mine), at)
          )
        : undefined
    if (j) holdings.push({ token: tokenOf(j), amount: balance })
    else others++
  }
  return { holdings, others }
}

/**
 * An address as wallets show it, by what toncenter's address book says it is: a person's wallet
 * (v1 to W5) non-bounceable, anything else (a contract, an exchange's highload wallet) bounceable.
 */
type Book = Record<string, { interfaces?: unknown } | undefined>
function shown(a: TonAddress, network: 0 | 1, book: Book): string {
  const entry = book[rawAddress(a).toUpperCase()] ?? book[rawAddress(a)]
  const wallet =
    Array.isArray(entry?.interfaces) &&
    entry.interfaces.some((i) => typeof i === 'string' && /^wallet_v\d/.test(i))
  return friendly(a, !wallet, network === 1)
}

/** The account's last twenty actions as toncenter reads them: TON and the jettons maki knows. */
export async function history(
  fetch: CoinFetch,
  network: 0 | 1,
  address: string,
  mine: TonAddress
): Promise<Activity[]> {
  const r = (await call(
    fetch,
    network,
    'GET',
    `/actions?account=${address}&limit=20&offset=0&sort=desc`
  )) as { actions?: unknown; address_book?: unknown }
  if (!Array.isArray(r.actions)) throw new Error('toncenter sent history maki desktop can’t read')
  const book = (typeof r.address_book === 'object' && r.address_book ? r.address_book : {}) as Book
  const out: Activity[] = []
  for (const a of r.actions as Record<string, unknown>[]) {
    const d = (a.details ?? {}) as Record<string, unknown>
    const time = typeof a.trace_end_utime === 'number' ? a.trace_end_utime : null
    const id =
      typeof a.trace_id === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(a.trace_id)
        ? hex.encode(base64.decode(a.trace_id))
        : null
    if (!id) continue
    const failed = a.success === false
    if (a.type === 'ton_transfer') {
      const from = fromRaw(d.source)
      const to = fromRaw(d.destination)
      if (!from || !to) continue
      const value = digits(d.value)
      const out_ = sameAddress(from, mine)
      const in_ = sameAddress(to, mine)
      if (!out_ && !in_) continue
      out.push({
        id,
        kind: out_ && in_ ? 'To itself' : out_ ? 'Sent' : 'Received',
        amount: out_ && in_ ? 0n : out_ ? -value : value,
        token: null,
        time,
        counterparty: shown(out_ ? to : from, network, book),
        failed
      })
    } else if (a.type === 'jetton_transfer' && network === 0) {
      const master = fromRaw(d.asset)
      const sender = fromRaw(d.sender)
      const receiver = fromRaw(d.receiver)
      if (!master || !sender || !receiver) continue
      const j = JETTONS.find((j) => sameAddress(j.master, master))
      if (!j) continue
      const ours = jettonWallet(j, mine)
      // the account's side of it must be its own jetton wallet for that master: anything else is
      // another jetton saying it's this one
      const sent =
        sameAddress(sender, mine) && sameAddress(fromRaw(d.sender_jetton_wallet) ?? mine, ours)
      const got =
        sameAddress(receiver, mine) && sameAddress(fromRaw(d.receiver_jetton_wallet) ?? mine, ours)
      if (!sent && !got) continue
      const amount = digits(d.amount)
      out.push({
        id,
        kind: sent ? 'Sent' : 'Received',
        amount: sent ? -amount : amount,
        token: tokenOf(j),
        time,
        counterparty: shown(sent ? receiver : sender, network, book),
        failed
      })
    }
  }
  return out
}

// ---- the wallets ----

/** What sending a payment needs besides maki's signature. */
interface TonCarry {
  signing: Cell
  /** the wallet's first state, when this payment sets it up */
  init: Cell | null
  validUntil: number
}

/** Why a wallet turns a message down, by its exit code: v4R2's (its source's), then W5's. */
const seqno =
  'the wallet’s seqno has moved on: another payment went first. Look again, and make this one again'
const notMine = 'the wallet says it’s for another wallet ID: not this account’s'
const badSignature = 'the wallet says maki’s signature isn’t its key’s'
const expired = 'it was no longer good when the wallet ran it: make it again'
const REFUSALS: Record<string, string> = {
  '33': seqno,
  '34': notMine,
  '35': badSignature,
  '36': expired,
  '132': 'this W5 wallet has its key’s signatures turned off: only an extension can send from it',
  '133': seqno,
  '134': notMine,
  '135': badSignature,
  '136': expired
}

/** How long a request is good for: long enough to go through it on maki, short enough to be done with. */
const VALID_FOR_S = 600

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function tonChain(wallet: TonWallet): AccountChain {
  const name = WALLET_NAME[wallet]
  /** The account's key, checked against the address maki shared (v4R2's) or this side made (W5's). */
  const keyOf = (account: SharedAccount): Uint8Array => {
    const key = accountKey(account)
    if (shownAddress(wallet, key, account.network) !== account.address)
      throw new Error(`maki’s TON key and its ${name} wallet’s address don’t agree`)
    return key
  }
  return {
    id: 'ton',
    name: 'TON',
    app: TON_APP,
    glyph: 'ton',
    tint: 'bg-sky/10 text-sky',
    units: ['TON', 'tTON'],
    decimals: 9,
    priced: 'TON',
    networks: ['TON', 'Testnet'],
    // the W5 wallet's messages to maki name it (TonApp); the v4R2 wallet's are the app's default
    appChain: wallet === 'v5R1' ? ['v5R1', 'v5R1'] : undefined,
    hint: 'UQ… or EQ…',
    memo: { label: 'Comment', placeholder: 'if the recipient asked for one', numeric: false },
    wallets: 'The account Ledger Live and Tonkeeper with a Ledger make',
    servers:
      'Balances and payments go through toncenter.com, TON’s own API (a request a second, without a key), which sees the account’s wallets’ addresses and this computer’s IP address. TON takes a payment’s fee from the wallet when it runs, at its prices then: maki desktop says what it expects it to be, which isn’t a limit.',
    explorerName: 'tonviewer.com',
    explorer: (network, kind, id) =>
      `https://${network === 1 ? 'testnet.' : ''}tonviewer.com/${kind === 'tx' ? 'transaction/' : ''}${id}`,
    uri: (address) => `ton://transfer/${address}`,
    valid: (address, network) => {
      const r = readAddress(address)
      // an address for TON's test network alone is no use on TON
      return r !== null && !(network === 0 && r.testOnly === true)
    },

    async look(fetch, account): Promise<ChainState> {
      const network = account.network
      const mine = walletAddress(wallet, keyOf(account), network)
      const info = await walletInfo(fetch, network, account.address)
      if (info.status === 'active' && info.type !== WALLET_TYPE[wallet])
        throw new Error(`toncenter says the ${name} wallet’s contract is ${info.type}`)
      const jettons = await jettonsOf(fetch, network, account.address, mine)
      const notes: string[] = []
      let activity: Activity[] = []
      try {
        activity = await history(fetch, network, account.address, mine)
      } catch (e) {
        notes.push(`Its history couldn’t be had: ${(e as Error).message}.`)
      }
      if (info.status === 'frozen')
        notes.push(
          'TON has frozen this wallet: its storage fees went unpaid. It can’t send until they’re paid, by sending it TON.'
        )
      else if (info.status !== 'active' && info.balance > 0n)
        notes.push(
          `This ${name} wallet isn’t set up on TON yet: its first payment sets it up (its code goes with it), which maki shows you.`
        )
      if (jettons.others > 0)
        notes.push(
          `It holds ${jettons.others} ${jettons.others === 1 ? 'jetton' : 'jettons'} maki doesn’t know, not shown: anyone can make a jetton and send it, and maki can’t tell what one is.`
        )
      return {
        holdings: [{ token: null, amount: info.balance }, ...jettons.holdings],
        activity,
        reserved: 0n,
        exists: true,
        notes
      }
    },

    async pay(fetch, account, state, to, amount, token, memo) {
      const network = account.network
      const key = keyOf(account)
      const mine = walletAddress(wallet, key, network)
      const dest = readAddress(to.trim())
      if (!dest || (network === 0 && dest.testOnly === true))
        throw new Error('that isn’t a TON address')
      const text = new TextEncoder().encode(memo)
      if (text.length > 1000) throw new Error('that comment is longer than maki desktop sends')
      const info = await walletInfo(fetch, network, account.address)
      if (info.status === 'frozen') throw new Error('TON has frozen this wallet: it can’t send')
      if (
        info.status === 'active' &&
        (info.type !== WALLET_TYPE[wallet] || info.id !== walletId(wallet, network))
      )
        throw new Error(`toncenter says this wallet isn’t the account’s ${name} wallet`)
      const first = info.status !== 'active'
      const seqno = first ? 0 : info.seqno
      let message: Cell
      let ton_ = amount
      if (token === null) {
        message = internalMessage({
          to: dest.address,
          value: amount,
          // as the address says it's sent to: bounceable comes back if nothing there takes it
          bounce: dest.bounceable ?? true,
          body: memo ? comment(memo) : Cell.EMPTY
        })
      } else {
        const j = network === 0 ? JETTONS.find((j) => tokenOf(j).id === token.id) : undefined
        if (!j) throw new Error('maki desktop sends only the jettons maki knows')
        const held = state.holdings.find((h) => h.token?.id === token.id)?.amount ?? 0n
        if (amount > held)
          throw new Error(`the wallet holds ${units(held, j.decimals)} ${j.symbol}`)
        ton_ = JETTON_TON
        message = internalMessage({
          to: jettonWallet(j, mine),
          value: JETTON_TON,
          bounce: true,
          body: jettonTransfer({ amount, to: dest.address, response: mine, comment: memo })
        })
      }
      const validUntil = Math.floor(Date.now() / 1000) + VALID_FOR_S
      const signing = signingCell(wallet, {
        walletId: walletId(wallet, network),
        validUntil,
        seqno,
        messages: [message]
      })
      const payload = writeBoc(signing)
      if (payload.length > 4090) throw new Error('that’s more than maki takes at once')
      const init = first ? walletInit(wallet, key, network) : null
      // what the wallet will be charged, as toncenter works it out now (a signature of zeros, unchecked)
      const estimate = (await call(fetch, network, 'POST', '/estimateFee', {
        address: account.address,
        body: base64.encode(writeBoc(signedBody(wallet, signing, new Uint8Array(64)))),
        ...(init
          ? {
              init_code: base64.encode(writeBoc(walletCode(wallet))),
              init_data: base64.encode(writeBoc(walletData(wallet, key, network)))
            }
          : {}),
        ignore_chksig: true
      })) as { source_fees?: Record<string, unknown> }
      const fees = estimate.source_fees
      const part = (k: string): bigint => {
        const v = fees?.[k]
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
          throw new Error('toncenter sent a fee maki desktop can’t read')
        return BigInt(v)
      }
      const fee = part('in_fwd_fee') + part('storage_fee') + part('gas_fee') + part('fwd_fee')
      if (part('gas_fee') === 0n)
        throw new Error('toncenter says the wallet wouldn’t run it: look again, and try again')
      if (ton_ + fee > info.balance)
        throw new Error(
          token === null
            ? `that and the network’s fee (about ${ton(fee)}) is more than the wallet’s ${ton(info.balance)}`
            : `sending it takes ${ton(JETTON_TON)} to the jetton wallets and about ${ton(fee)} for the network: the wallet has ${ton(info.balance)}`
        )
      const notes = [
        `TON takes the fee from the wallet when it runs the payment: about ${ton(fee)} now, at TON’s prices then.`
      ]
      if (token !== null)
        notes.push(
          `${ton(JETTON_TON)} goes with it to the jetton wallets for their fees; what they don’t use comes back.`
        )
      if (first)
        notes.push(
          `It’s this ${name} wallet’s first payment: it sets the wallet up on TON as well.`
        )
      return {
        payload,
        fee,
        feeIsMost: false,
        notes,
        carry: { signing, init, validUntil } satisfies TonCarry
      }
    },

    async submit(fetch, account, payment, signature) {
      const network = account.network
      const key = keyOf(account)
      const mine = walletAddress(wallet, key, network)
      const c = payment.carry as TonCarry
      // checked here first: the wallet would refuse a bad one, and charge nothing, but say little
      if (signature.length !== 64 || !ed25519.verify(signature, c.signing.hash(), key))
        throw new Error('maki’s TON app gave a signature that doesn’t check out')
      if (Date.now() / 1000 > c.validUntil)
        throw new Error('it was good for ten minutes, and they’ve passed: make it again')
      const body = signedBody(wallet, c.signing, signature)
      const message = externalMessage(mine, c.init, body)
      const sent = (await call(fetch, network, 'POST', '/message', {
        boc: base64.encode(writeBoc(message))
      }).catch((e: Error) => {
        // the wallet's own refusals, said plainly: its exit code says which
        const code = /exitcode=(\d+)/.exec(e.message)?.[1]
        throw new Error(REFUSALS[code ?? ''] ?? e.message)
      })) as { message_hash?: unknown; message_hash_norm?: unknown }
      const norm = normalizedHash(mine, body)
      if (
        sent.message_hash !== base64.encode(message.hash()) ||
        sent.message_hash_norm !== base64.encode(norm)
      )
        throw new Error('toncenter took a different message from the one maki signed')
      // the wallet's transaction, once TON has run it: whether it sent what it was asked to
      for (let tries = 0; tries < 20; tries++) {
        if (tries) await sleep(1500)
        const r = (await call(
          fetch,
          network,
          'GET',
          `/transactionsByMessage?msg_hash=${hex.encode(norm)}&direction=in&limit=1`
        )) as { transactions?: Record<string, unknown>[] }
        const tx = r.transactions?.[0]
        if (!tx) continue
        const d = (tx.description ?? {}) as {
          aborted?: unknown
          compute_ph?: { success?: unknown; exit_code?: unknown }
          action?: { success?: unknown; skipped_actions?: unknown; no_funds?: unknown }
        }
        if (d.compute_ph?.success !== true)
          throw new Error(
            `TON ran it and the wallet refused it (exit code ${String(d.compute_ph?.exit_code)})`
          )
        if (
          d.action?.success !== true ||
          d.action.no_funds === true ||
          Number(d.action.skipped_actions) > 0
        )
          throw new Error(
            'TON ran it, and the wallet didn’t send it: it didn’t hold enough for the payment and its fees then (the fee was taken)'
          )
        if (typeof tx.hash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(tx.hash))
          throw new Error('toncenter sent a transaction maki desktop can’t read')
        return hex.encode(base64.decode(tx.hash))
      }
      // taken, not run yet: its message's hash finds it later
      return hex.encode(norm)
    }
  }
}

/** The account's v4R2 wallet: the one maki shares, and Ledger Live shows. */
export const TON = tonChain('v4R2')
/** The same key's W5 wallet. */
export const TON_W5 = tonChain('v5R1')
