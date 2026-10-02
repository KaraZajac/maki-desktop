/**
 * An Electrum protocol client (JSON-RPC, a line each, over TLS), as Electron Cash speaks to
 * Fulcrum: for the chains whose servers are Electrum's (Bitcoin Cash). One connection at a time,
 * requests sent along it as they come; a server that fails or stops answering gives way to the next
 * in the list. Each server's certificate is checked as any site's: no self-signed ones.
 */
import tls from 'node:tls'

export interface ElectrumServer {
  host: string
  port: number
}

/** How long one answer is waited for. */
const ANSWER_MS = 15_000

export class Electrum {
  private socket: tls.TLSSocket | null = null
  private ready: Promise<void> | null = null
  private next = 1
  private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  private at = 0

  constructor(
    private servers: ElectrumServer[],
    private name: string
  ) {}

  /** The server's answer to `method`, from the first server that gives one. */
  async call(method: string, params: unknown[]): Promise<unknown> {
    let problem: Error | null = null
    for (let tries = 0; tries < Math.min(3, this.servers.length); tries++) {
      try {
        await this.connect()
        return await this.send(method, params)
      } catch (e) {
        problem = e as Error
        // a server that said no to this request answered: it isn't the server's fault
        if ((e as { server?: boolean }).server) throw e
        this.drop(problem)
        this.at = (this.at + 1) % this.servers.length
      }
    }
    throw new Error(
      `${this.name}’s servers can’t be reached${problem ? `: ${problem.message}` : ''}`
    )
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready
    const { host, port } = this.servers[this.at]
    this.ready = new Promise<void>((ok, fail) => {
      const socket = tls.connect({ host, port, servername: host, timeout: ANSWER_MS }, () => {
        this.socket = socket
        // the protocol version first, as every client says it
        this.send('server.version', ['maki desktop', '1.4']).then(() => ok(), fail)
      })
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          this.answer(line)
        }
        // a server that never ends a line isn't one to keep reading
        if (buffer.length > 8 * 1024 * 1024) socket.destroy(new Error('an answer too big'))
      })
      socket.on('timeout', () => socket.destroy(new Error('it stopped answering')))
      socket.on('error', (e) => {
        fail(e)
        this.drop(e)
      })
      socket.on('close', () => this.drop(new Error('the connection closed')))
    })
    return this.ready
  }

  private send(method: string, params: unknown[]): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('not connected'))
    const id = this.next++
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        fail(new Error('no answer in time'))
      }, ANSWER_MS)
      this.waiting.set(id, {
        ok: (v) => {
          clearTimeout(timer)
          ok(v)
        },
        fail: (e) => {
          clearTimeout(timer)
          fail(e)
        }
      })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private answer(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const w = msg.id === undefined ? undefined : this.waiting.get(msg.id)
    if (!w) return
    this.waiting.delete(msg.id!)
    if (msg.error) {
      const e = new Error(String(msg.error.message ?? 'the server said no').slice(0, 300))
      ;(e as { server?: boolean }).server = true
      w.fail(e)
    } else w.ok(msg.result)
  }

  private drop(why: Error): void {
    this.socket?.destroy()
    this.socket = null
    this.ready = null
    for (const w of this.waiting.values()) w.fail(why)
    this.waiting.clear()
  }

  close(): void {
    this.drop(new Error('closed'))
  }
}
