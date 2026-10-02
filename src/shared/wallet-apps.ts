/**
 * maki's wallets, which are apps from the maki store (the firmware's ARCHITECTURE.md, "Wallets are
 * apps"): Bitcoin, Litecoin, Ethereum, Monero and Solana, the SDK's examples `bitcoin`, `litecoin`,
 * `ethereum`, `monero` and `solana`. maki
 * keeps the keys and lets each app sign only for its own accounts; the app reads what it's asked to
 * sign, shows it on maki's screen and signs once the owner says yes. Their messages are in each
 * app's source; the calls here are the ones MakiClient made when the wallets were maki's own, with
 * the same answers, and 'no match' when the app isn't installed.
 *
 * No Node or DOM imports here: this module runs in the renderer and in tests.
 */
import {
  type ApprovalValue,
  BtcAccount,
  type BtcAccountValue,
  MAX_APP_MESSAGE,
  type NetworkValue,
  Reader,
  Writer
} from './protocol'
import { Writer as XmrWriter } from './monero/transaction'
import type { MultisigWallet } from './multisig'
import { base58 } from '@scure/base'

export const BITCOIN_APP = 'com.leviathan.maki.bitcoin'
/** Litecoin's app speaks the Bitcoin app's messages (it's Bitcoin's wallet code on Litecoin's networks). */
export const LITECOIN_APP = 'com.leviathan.maki.litecoin'
export const ETHEREUM_APP = 'com.leviathan.maki.ethereum'
export const MONERO_APP = 'com.leviathan.maki.monero'
export const SOLANA_APP = 'com.leviathan.maki.solana'

/** Talking to an app on maki (Link.appMessage): its answer, if maki has it and it answered. */
export type AppMessage = (
  app: string,
  message: Uint8Array,
  timeoutMs?: number
) => Promise<{ status: ApprovalValue; answer: Uint8Array }>

/** How long an answer the owner gives waits: the apps give them five minutes for a transaction. */
export const SIGN_TIMEOUT_MS = 330_000
/** And one they don't: maki may have to start the app first. */
const PIECE_TIMEOUT_MS = 60_000

/** The biggest PSBT the Bitcoin app takes in. */
export const MAX_PSBT = 256 * 1024
/** The biggest transaction, and typed data, the Ethereum app takes in. */
export const MAX_TX = 128 * 1024
export const MAX_TYPED = 64 * 1024

/** What the apps' answers start with. */
const OK = 0
const DENIED = 1
const NO_ANSWER = 2
const LOCKED = 3
/** a message the app couldn't read: this side's mistake, or a site name maki won't show */
const BAD = 4
const REFUSED = 5
/** a piece taken: send the next */
const MORE = 6

/** An app's status, as the link says it. */
function approval(status: number | undefined): ApprovalValue {
  switch (status) {
    case OK:
      return 'approved'
    case DENIED:
      return 'denied'
    case NO_ANSWER:
      return 'timed out'
    case LOCKED:
      return 'locked'
    case REFUSED:
      return 'refused'
    default:
      return 'unavailable'
  }
}

/** An answer from a wallet app: its status, then its fields. */
class Answer {
  readonly approval: ApprovalValue
  readonly status: number | undefined
  private r: Reader

  constructor(private answer: Uint8Array) {
    this.status = answer[0]
    this.approval = approval(answer[0])
    this.r = new Reader(answer.subarray(1))
  }

  text(): string {
    return new TextDecoder().decode(this.r.bytes16())
  }
  u32(): number {
    return this.r.u32()
  }
  fixed(n: number): Uint8Array {
    return this.r.fixed(n)
  }
  /** what's left of it */
  rest(): Uint8Array {
    return this.answer.slice(1 + this.r.offset)
  }
  /** why the app refused, if it said */
  reason(): string {
    try {
      return this.status === REFUSED ? this.text() : ''
    } catch {
      return ''
    }
  }
}

/** A wallet app on maki. */
class WalletApp {
  constructor(
    private send: AppMessage,
    readonly id: string,
    readonly name: string
  ) {}

  /** The app's answer, or what the link said instead ('no match': it isn't installed). */
  protected async ask(message: Uint8Array, timeoutMs: number): Promise<Answer | ApprovalValue> {
    const r = await this.send(this.id, message, timeoutMs)
    if (r.status !== 'approved') return r.status
    if (r.answer.length === 0) return 'unavailable'
    if (r.answer[0] === BAD) throw new Error(`maki’s ${this.name} app couldn’t read that`)
    return new Answer(r.answer)
  }

  /**
   * Something big, in pieces: `head`, the total and the offset, `tail`, then as much as a
   * message holds. The last piece's answer, once the owner has gone through it on maki.
   */
  protected async pieces(
    head: Uint8Array,
    tail: Uint8Array,
    bytes: Uint8Array
  ): Promise<Answer | ApprovalValue> {
    const room = MAX_APP_MESSAGE - head.length - 8 - tail.length
    for (let offset = 0; offset < bytes.length;) {
      const piece = bytes.subarray(offset, offset + room)
      const last = offset + piece.length >= bytes.length
      const m = new Writer().u32(bytes.length).u32(offset).finish()
      const a = await this.ask(
        Uint8Array.from([...head, ...m, ...tail, ...piece]),
        last ? SIGN_TIMEOUT_MS : PIECE_TIMEOUT_MS
      )
      if (typeof a === 'string' || a.status !== MORE) return a
      if (last) return 'unavailable'
      offset += piece.length
    }
    return 'unavailable'
  }

  /** What the app signed last, fetched a piece at a time: null if it didn't all come. */
  protected async signed(total: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(total)
    for (let offset = 0; offset < total;) {
      const a = await this.ask(new Writer().u8(SIGNED).u32(offset).finish(), PIECE_TIMEOUT_MS)
      if (typeof a === 'string' || a.status !== OK) return null
      try {
        const size = a.u32()
        const at = a.u32()
        const piece = a.rest()
        if (size !== total || at !== offset || piece.length === 0 || offset + piece.length > total)
          return null
        out.set(piece, offset)
        offset += piece.length
      } catch {
        return null
      }
    }
    return out
  }
}

/** `G`, in both apps: a piece of what was signed last. */
const SIGNED = 0x47

/** maki's Bitcoin app: native SegWit (BIP84) and taproot (BIP86) accounts. */
export class BitcoinApp extends WalletApp {
  /** maki's Bitcoin app; or its Litecoin app, which takes the same messages but multisig's. */
  constructor(send: AppMessage, id = BITCOIN_APP, name = 'Bitcoin') {
    super(send, id, name)
  }

  /** The account's key (zpub; an xpub for taproot) and output descriptor, once the owner agrees on maki. */
  async account(
    network: NetworkValue,
    account: BtcAccountValue = BtcAccount.SEGWIT
  ): Promise<{ approval: ApprovalValue; zpub: string; descriptor: string }> {
    const a = await this.ask(Uint8Array.of(0x41, network, account), SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, zpub: '', descriptor: '' }
    if (a.approval !== 'approved') return { approval: a.approval, zpub: '', descriptor: '' }
    return { approval: a.approval, zpub: a.text(), descriptor: a.text() }
  }

  /**
   * Put an address on maki's screen for the owner to compare with this computer's: 'approved'
   * if they said it matches, 'denied' if it doesn't. `address` is maki's, either way.
   */
  async address(
    network: NetworkValue,
    change: boolean,
    index: number,
    account: BtcAccountValue = BtcAccount.SEGWIT
  ): Promise<{ approval: ApprovalValue; address: string }> {
    const m = new Writer()
      .u8(0x44)
      .u8(network)
      .u8(account)
      .u8(change ? 1 : 0)
      .u32(index)
      .finish()
    const a = await this.ask(m, SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, address: '' }
    let address = ''
    try {
      address = a.text()
    } catch {
      // locked, or no answer: nothing shown
    }
    return { approval: a.approval, address }
  }

  /**
   * maki's key for multisig wallets (BIP48's, P2WSH), with its origin, once the owner agrees on
   * maki: `[73c5da0a/48h/0h/0h/2h]Zpub…`, as a coordinator takes a cosigner's.
   */
  async cosigner(network: NetworkValue): Promise<{ approval: ApprovalValue; key: string }> {
    const a = await this.ask(Uint8Array.of(0x4b, network), SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, key: '' }
    return { approval: a.approval, key: a.approval === 'approved' ? a.text() : '' }
  }

  /**
   * Add a multisig wallet with maki's key in it (its descriptor, or Coldcard's multisig file), once
   * the owner has gone through it on maki: every key's fingerprint and xpub. `name` names it if the
   * text doesn't. Its ID and name; or why maki's app refused it.
   */
  async addMultisig(
    network: NetworkValue,
    name: string,
    text: string
  ): Promise<{ approval: ApprovalValue; reason: string; id: string; name: string }> {
    const enc = new TextEncoder()
    const m = new Writer()
      .u8(0x4d)
      .u8(network)
      .bytes16(enc.encode(name))
      .bytes16(enc.encode(text))
      .finish()
    if (m.length > MAX_APP_MESSAGE)
      return {
        approval: 'refused',
        reason: 'that wallet is too big to send to maki',
        id: '',
        name: ''
      }
    const a = await this.ask(m, SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, reason: '', id: '', name: '' }
    if (a.approval !== 'approved')
      return { approval: a.approval, reason: a.reason(), id: '', name: '' }
    const id = [...a.fixed(4)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return { approval: 'approved', reason: '', id, name: a.text() }
  }

  /** The multisig wallets maki has added. */
  async multisigs(): Promise<{ approval: ApprovalValue; wallets: MultisigWallet[] }> {
    const a = await this.ask(Uint8Array.of(0x57), 30_000)
    if (typeof a === 'string') return { approval: a, wallets: [] }
    if (a.approval !== 'approved') return { approval: a.approval, wallets: [] }
    const wallets: MultisigWallet[] = []
    for (let n = a.fixed(1)[0]; n > 0; n--) {
      const id = [...a.fixed(4)].map((b) => b.toString(16).padStart(2, '0')).join('')
      const [network, threshold, keys] = a.fixed(3)
      wallets.push({ id, network, threshold, keys, name: a.text() })
    }
    return { approval: 'approved', wallets }
  }

  /** A multisig wallet's address on maki's screen, to compare with this computer's. */
  async multisigAddress(
    id: string,
    change: boolean,
    index: number
  ): Promise<{ approval: ApprovalValue; address: string }> {
    const idBytes = Uint8Array.from(id.match(/../g) ?? [], (h) => parseInt(h, 16))
    const m = new Writer()
      .u8(0x45)
      .bytes(idBytes)
      .u8(change ? 1 : 0)
      .u32(index)
      .finish()
    const a = await this.ask(m, SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, address: '' }
    let address = ''
    try {
      address = a.text()
    } catch {
      // locked, or no answer
    }
    return { approval: a.approval, address }
  }

  /**
   * Sign a PSBT: the app checks it, the owner goes through it on maki's screen, and it comes back
   * with a signature for each input. Refused ones come back with the app's reason. A multisig
   * wallet's is signed once maki has added the wallet.
   */
  async sign(
    network: NetworkValue,
    psbt: Uint8Array
  ): Promise<{ approval: ApprovalValue; reason: string; signed: Uint8Array | null }> {
    if (psbt.length === 0 || psbt.length > MAX_PSBT) {
      return {
        approval: 'refused',
        reason: `a PSBT maki takes is 1 byte to ${MAX_PSBT / 1024} KiB`,
        signed: null
      }
    }
    const a = await this.pieces(Uint8Array.of(0x50, network), new Uint8Array(), psbt)
    if (typeof a === 'string') return { approval: a, reason: '', signed: null }
    if (a.approval !== 'approved') return { approval: a.approval, reason: a.reason(), signed: null }
    const signed = await this.signed(a.u32())
    return signed
      ? { approval: 'approved', reason: '', signed }
      : { approval: 'unavailable', reason: '', signed: null }
  }
}

/** maki's Ethereum app: BIP44 accounts (`m/44'/60'/0'/0/i`), for sites and maki desktop's wallet. */
export class EthereumApp extends WalletApp {
  constructor(send: AppMessage) {
    super(send, ETHEREUM_APP, 'Ethereum')
  }

  private static head(kind: number, index: number): Uint8Array {
    return new Writer().u8(kind).u32(index).finish()
  }

  private static site(site: string): Uint8Array {
    return new Writer().str8(site).finish()
  }

  /** The account's address (EIP-55), once the owner lets `site` connect on maki. */
  async ethAccount(site: string, index = 0): Promise<{ approval: ApprovalValue; address: string }> {
    const a = await this.ask(
      Uint8Array.from([...EthereumApp.head(0x41, index), ...EthereumApp.site(site)]),
      SIGN_TIMEOUT_MS
    )
    if (typeof a === 'string') return { approval: a, address: '' }
    if (a.approval !== 'approved') return { approval: a.approval, address: '' }
    return { approval: a.approval, address: a.text() }
  }

  /** Sign a message (EIP-191 personal_sign) once the owner has read it: r, s, v (65 bytes). */
  async ethSignMessage(
    site: string,
    message: Uint8Array,
    index = 0
  ): Promise<{ approval: ApprovalValue; signature: Uint8Array }> {
    const m = Uint8Array.from([
      ...EthereumApp.head(0x4d, index),
      ...EthereumApp.site(site),
      ...message
    ])
    if (m.length > MAX_APP_MESSAGE) return { approval: 'refused', signature: new Uint8Array() }
    const a = await this.ask(m, SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, signature: new Uint8Array() }
    if (a.approval !== 'approved') return { approval: a.approval, signature: new Uint8Array() }
    try {
      return { approval: a.approval, signature: a.fixed(65) }
    } catch {
      return { approval: 'unavailable', signature: new Uint8Array() }
    }
  }

  /**
   * Sign a transaction (unsigned EIP-1559 or EIP-155 bytes): the app shows the owner what it
   * does, and it comes back signed, ready for eth_sendRawTransaction. Refused ones come back with
   * the app's reason.
   */
  async ethSignTransaction(
    site: string,
    unsigned: Uint8Array,
    index = 0
  ): Promise<{ approval: ApprovalValue; reason: string; signed: Uint8Array | null }> {
    if (unsigned.length === 0 || unsigned.length > MAX_TX) {
      return {
        approval: 'refused',
        reason: `a transaction maki takes is 1 byte to ${MAX_TX / 1024} KiB`,
        signed: null
      }
    }
    const a = await this.pieces(EthereumApp.head(0x54, index), EthereumApp.site(site), unsigned)
    if (typeof a === 'string') return { approval: a, reason: '', signed: null }
    if (a.approval !== 'approved') return { approval: a.approval, reason: a.reason(), signed: null }
    const signed = await this.signed(a.u32())
    return signed
      ? { approval: 'approved', reason: '', signed }
      : { approval: 'unavailable', reason: '', signed: null }
  }

  /**
   * Sign typed data (EIP-712: the JSON eth_signTypedData_v4 takes): the app reads it itself,
   * shows the owner what it says, and signs it: r, s, v (65 bytes). Refused ones come back with
   * the app's reason.
   */
  async ethSignTypedData(
    site: string,
    json: string,
    index = 0
  ): Promise<{ approval: ApprovalValue; reason: string; signature: Uint8Array | null }> {
    const bytes = new TextEncoder().encode(json)
    if (bytes.length === 0 || bytes.length > MAX_TYPED) {
      return {
        approval: 'refused',
        reason: `typed data maki takes is 1 byte to ${MAX_TYPED / 1024} KiB`,
        signature: null
      }
    }
    const a = await this.pieces(EthereumApp.head(0x59, index), EthereumApp.site(site), bytes)
    if (typeof a === 'string') return { approval: a, reason: '', signature: null }
    if (a.approval !== 'approved')
      return { approval: a.approval, reason: a.reason(), signature: null }
    try {
      return { approval: a.approval, reason: '', signature: a.fixed(65) }
    } catch {
      return { approval: 'unavailable', reason: '', signature: null }
    }
  }
}

/** Monero's networks, as the Monero app numbers them. */
export const MoneroNetwork = { MONERO: 0, TESTNET: 1, STAGENET: 2 } as const
export type MoneroNetworkValue = (typeof MoneroNetwork)[keyof typeof MoneroNetwork]

/** The biggest request the Monero app takes to sign: 16 inputs. */
export const MAX_MONERO_REQUEST = 64 * 1024
/** Outputs a `K` asks about at once. */
const KEY_IMAGES_AT_ONCE = 40

/** An output of the wallet's, whose key image maki makes (`K`). */
export interface MoneroOutput {
  /** its transaction's public key, or its own additional key */
  txKey: Uint8Array
  /** its index in that transaction */
  index: bigint
  major: number
  minor: number
  key: Uint8Array
}

/**
 * maki's Monero app: the account Ledger's Monero app makes from the same phrase. Its backup
 * words, the 25 any Monero wallet restores from, are shown on maki alone (the app's menu). A
 * computer the owner lets watch the wallet gets its view key, and asks maki to spend: maki makes
 * each transaction itself, from what it's asked to pay, once the owner has seen it.
 */
export class MoneroApp extends WalletApp {
  constructor(send: AppMessage) {
    super(send, MONERO_APP, 'Monero')
  }

  /**
   * Put an address on maki's screen for the owner to compare with this computer's: account
   * `account`'s address `index` (0 and 0: the primary address; any other, a subaddress).
   * 'approved' if they said it matches, 'denied' if it doesn't; `address` is maki's, either way.
   */
  async address(
    network: MoneroNetworkValue,
    account = 0,
    index = 0
  ): Promise<{ approval: ApprovalValue; address: string }> {
    const m = new Writer().u8(0x44).u8(network).u32(account).u32(index).finish()
    const a = await this.ask(m, SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, address: '' }
    let address = ''
    try {
      address = a.text()
    } catch {
      // locked, or no answer: nothing shown
    }
    return { approval: a.approval, address }
  }

  /**
   * Let this computer watch the wallet, once the owner agrees on maki: the primary address and the
   * secret view key, which finds the wallet's payments and can't spend them.
   */
  async watch(
    network: MoneroNetworkValue
  ): Promise<{ approval: ApprovalValue; address: string; viewKey: Uint8Array | null }> {
    const a = await this.ask(Uint8Array.of(0x57, network), SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, address: '', viewKey: null }
    if (a.approval !== 'approved') return { approval: a.approval, address: '', viewKey: null }
    try {
      return { approval: a.approval, address: a.text(), viewKey: a.fixed(32) }
    } catch {
      return { approval: 'unavailable', address: '', viewKey: null }
    }
  }

  /**
   * Outputs' key images, each with what proves it's that output's (a ring signature of one, as a
   * view-only wallet imports them): once the owner has let a computer watch the wallet. Refused
   * ones come back with the app's reason.
   */
  async keyImages(
    outputs: MoneroOutput[],
    progress?: (done: number) => void
  ): Promise<{
    approval: ApprovalValue
    reason: string
    images: { image: Uint8Array; proof: Uint8Array }[]
  }> {
    const images: { image: Uint8Array; proof: Uint8Array }[] = []
    for (let at = 0; at < outputs.length; at += KEY_IMAGES_AT_ONCE) {
      const batch = outputs.slice(at, at + KEY_IMAGES_AT_ONCE)
      const w = new XmrWriter().u8(0x4b).u8(batch.length)
      for (const o of batch) w.key(o.txKey).u64(o.index).u32(o.major).u32(o.minor).key(o.key)
      const a = await this.ask(w.finish(), PIECE_TIMEOUT_MS)
      if (typeof a === 'string') return { approval: a, reason: '', images: [] }
      if (a.approval !== 'approved') return { approval: a.approval, reason: a.reason(), images: [] }
      try {
        for (let i = 0; i < batch.length; i++)
          images.push({ image: a.fixed(32), proof: a.fixed(64) })
      } catch {
        return { approval: 'unavailable', reason: '', images: [] }
      }
      progress?.(images.length)
    }
    return { approval: 'approved', reason: '', images }
  }

  /**
   * Spend: `request` says what (the outputs spent, in their rings, and the payments, the change
   * and the fee); the owner goes through it on maki's screen, and maki makes the transaction and
   * signs it. It comes back whole (`decodeSigned`), or refused with the app's reason.
   */
  async sign(
    network: MoneroNetworkValue,
    request: Uint8Array
  ): Promise<{ approval: ApprovalValue; reason: string; signed: Uint8Array | null }> {
    if (request.length === 0 || request.length > MAX_MONERO_REQUEST) {
      return {
        approval: 'refused',
        reason: 'more than maki signs at once (16 inputs)',
        signed: null
      }
    }
    const a = await this.pieces(Uint8Array.of(0x53, network), new Uint8Array(), request)
    if (typeof a === 'string') return { approval: a, reason: '', signed: null }
    if (a.approval !== 'approved') return { approval: a.approval, reason: a.reason(), signed: null }
    const signed = await this.signed(a.u32())
    return signed
      ? { approval: 'approved', reason: '', signed }
      : { approval: 'unavailable', reason: '', signed: null }
  }
}

/**
 * maki's Solana app: its account (m/44'/501'/index'/0', as Phantom has it), and signatures over
 * what the app reads and shows the owner itself, a transaction's message or a message.
 */
export class SolanaApp extends WalletApp {
  constructor(send: AppMessage) {
    super(send, SOLANA_APP, 'Solana')
  }

  private static head(kind: number, index: number, site: string): Uint8Array {
    return new Writer().u8(kind).u32(index).str8(site).finish()
  }

  /** The account's address (its key, base58), once the owner lets `site` connect on maki. */
  async solAccount(
    site: string,
    index = 0
  ): Promise<{ approval: ApprovalValue; reason: string; address: string }> {
    const a = await this.ask(SolanaApp.head(0x41, index, site), SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, reason: '', address: '' }
    if (a.approval !== 'approved') return { approval: a.approval, reason: a.reason(), address: '' }
    try {
      return { approval: a.approval, reason: '', address: base58.encode(a.fixed(32)) }
    } catch {
      return { approval: 'unavailable', reason: '', address: '' }
    }
  }

  private async signature(
    kind: number,
    site: string,
    bytes: Uint8Array,
    index: number
  ): Promise<{ approval: ApprovalValue; reason: string; signature: Uint8Array | null }> {
    const m = Uint8Array.from([...SolanaApp.head(kind, index, site), ...bytes])
    if (bytes.length === 0 || m.length > MAX_APP_MESSAGE) {
      return { approval: 'refused', reason: 'bigger than maki takes', signature: null }
    }
    const a = await this.ask(m, SIGN_TIMEOUT_MS)
    if (typeof a === 'string') return { approval: a, reason: '', signature: null }
    if (a.approval !== 'approved')
      return { approval: a.approval, reason: a.reason(), signature: null }
    try {
      return { approval: a.approval, reason: '', signature: a.fixed(64) }
    } catch {
      return { approval: 'unavailable', reason: '', signature: null }
    }
  }

  /**
   * Sign a transaction's message: the app reads it (legacy or version 0), shows the owner what it
   * sends and to whom, and the most its fee can be, and signs: 64 bytes, for the transaction's slot
   * for this account. Refused ones come back with the app's reason.
   */
  solSignTransaction(
    site: string,
    message: Uint8Array,
    index = 0
  ): Promise<{ approval: ApprovalValue; reason: string; signature: Uint8Array | null }> {
    return this.signature(0x54, site, message, index)
  }

  /** Sign a message (signMessage, Sign In With Solana) once the owner has read it on maki. */
  solSignMessage(
    site: string,
    message: Uint8Array,
    index = 0
  ): Promise<{ approval: ApprovalValue; reason: string; signature: Uint8Array | null }> {
    return this.signature(0x4d, site, message, index)
  }
}
