import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { parseRequest, type BridgeRequest, type BridgeResponse, type BridgeResult } from '../shared/bridge-types'

/**
 * The app's side of the browser bridge: a local socket the native messaging host connects to.
 * User-only (a 0600 socket, or a per-user named pipe), but any process running as this user can
 * reach it, so it gives out nothing on its own: every secret still needs a press on maki.
 */

export function socketPath(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\maki-${userInfo().username}`
  const dir = process.env['XDG_RUNTIME_DIR'] ?? tmpdir()
  return join(dir, `maki-${userInfo().uid}.sock`)
}

export type Handler = (request: BridgeRequest) => Promise<BridgeResult>

/** One JSON object per line in both directions; requests may overlap. */
export function serveBridge(handler: Handler, path = socketPath()): Promise<Server> {
  if (process.platform !== 'win32' && existsSync(path)) unlinkSync(path) // stale, from a crash
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    const send = (response: BridgeResponse): void => {
      if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n')
    }
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 64 * 1024) return socket.destroy() // nothing legitimate is this big
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let request: BridgeRequest | null = null
        let id = -1
        try {
          const parsed: unknown = JSON.parse(line)
          id = typeof (parsed as { id?: unknown })?.id === 'number' ? (parsed as { id: number }).id : -1
          request = parseRequest(parsed)
        } catch {
          /* not JSON */
        }
        if (!request) {
          send({ id, ok: false, error: 'malformed request' })
          continue
        }
        const { id: rid } = request
        handler(request).then(
          (result) => send({ id: rid, ok: true, ...result }),
          (e: Error) => send({ id: rid, ok: false, error: e.message })
        )
      }
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
