/**
 * maki's wallets, which are apps from the maki store (the firmware's ARCHITECTURE.md, "Wallets
 * are apps"): Bitcoin and Ethereum, the SDK's examples `bitcoin` and `ethereum`. maki keeps the
 * keys and lets each app sign only for its own accounts; the app reads what it's asked to sign,
 * shows it on maki's screen and signs once the owner says yes. Their messages are in each app's
 * source; the calls here are the ones MakiClient made when the wallets were maki's own, with the
 * same answers, and 'no match' when the app isn't installed.
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

export const BITCOIN_APP = 'com.leviathan.maki.bitcoin'
export const ETHEREUM_APP = 'com.leviathan.maki.ethereum'

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
  constructor(send: AppMessage) {
    super(send, BITCOIN_APP, 'Bitcoin')
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
   * Sign a PSBT: the app checks it, the owner goes through it on maki's screen, and it comes back
   * with a signature for each input. Refused ones come back with the app's reason.
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
