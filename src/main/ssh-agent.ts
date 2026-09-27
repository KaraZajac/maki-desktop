import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * maki desktop's SSH agent: ssh and git talk to it (through SSH_AUTH_SOCK), and it hands each
 * request to maki's SSH app as a message, with a number for the connection it came on, and the
 * app's answer back. It holds no keys and reads nothing it passes: the app, on maki, reads what
 * is to be signed, shows the owner, and signs only if they say yes. When maki isn't linked, or
 * the app isn't installed, every request fails, as an agent with no keys would.
 */

export { SSH_APP } from '../shared/bridge-types'

/** Agent messages are at most this big here: they go to maki whole. */
const MAX_REQUEST = 4096 - 4
const FAILURE = new Uint8Array([0, 0, 0, 1, 5])

export function agentSocketPath(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\maki-ssh-agent-${userInfo().username}`
  const dir = process.env['XDG_RUNTIME_DIR'] ?? tmpdir()
  return join(dir, `maki-ssh-agent-${userInfo().uid}.sock`)
}

/** Sends a message to maki's SSH app: the answer, or null for none. */
export type ToApp = (message: Uint8Array) => Promise<Uint8Array | null>

let nextConnection = 1

/** One request at a time on each connection, as ssh sends them. */
export function serveAgent(toApp: ToApp, path = agentSocketPath()): Promise<Server> {
  if (process.platform !== 'win32' && existsSync(path)) unlinkSync(path) // stale, from a crash
  const server = createServer((socket: Socket) => {
    const conn = nextConnection++ >>> 0
    let buffer = new Uint8Array(0)
    let busy = false
    const next = async (): Promise<void> => {
      if (busy || buffer.length < 4) return
      const len = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0)
      if (len === 0 || len > MAX_REQUEST) return void socket.destroy() // nothing an agent is sent is this big
      if (buffer.length < 4 + len) return
      const request = buffer.slice(4, 4 + len)
      buffer = buffer.slice(4 + len)
      busy = true
      const message = new Uint8Array(4 + len)
      new DataView(message.buffer).setUint32(0, conn)
      message.set(request, 4)
      let reply = FAILURE
      try {
        const answer = await toApp(message)
        if (answer && answer.length > 0) {
          reply = new Uint8Array(4 + answer.length)
          new DataView(reply.buffer).setUint32(0, answer.length)
          reply.set(answer, 4)
        }
      } catch {
        /* not linked, or maki went away: no keys */
      }
      if (!socket.destroyed) socket.write(reply)
      busy = false
      void next()
    }
    socket.on('data', (chunk: Buffer) => {
      const joined = new Uint8Array(buffer.length + chunk.length)
      joined.set(buffer)
      joined.set(chunk, buffer.length)
      buffer = joined
      void next()
    })
    socket.on('error', () => socket.destroy())
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      if (process.platform !== 'win32') chmodSync(path, 0o600)
      resolve(server)
    })
  })
}
