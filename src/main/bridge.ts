import { chmodSync, existsSync, lstatSync, mkdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  EXTENSION_REQUESTS,
  parseRequest,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeResult
} from '../shared/bridge-types'

/**
 * The app's side of the browser bridge: a local socket the native messaging host connects to.
 * User-only (a 0600 socket, or a per-user named pipe), but any process running as this user can
 * reach it, so it gives out nothing on its own: every secret still needs a press on maki.
 */

export function socketPath(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\maki-${userInfo().username}`
  return join(privateDir(), `maki-${userInfo().uid}.sock`)
}

/**
 * Where this user's sockets go: $XDG_RUNTIME_DIR, which is theirs alone; where there's none, a
 * folder of their own in the temporary folder, made 0700. One someone else made there first, to
 * take the sockets' place (and what's sent to them: saved passwords), is refused, by this app and
 * by the commands that connect to it.
 */
export function privateDir(): string {
  const run = process.env['XDG_RUNTIME_DIR']
  if (run) return run
  const dir = join(tmpdir(), `maki-${userInfo().uid}`)
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  const s = lstatSync(dir)
  if (!s.isDirectory() || s.uid !== userInfo().uid || (s.mode & 0o077) !== 0)
    throw new Error(`${dir} isn’t this user’s own folder: maki desktop won’t use it`)
  return dir
}

/** A socket's path made free: what a crash left there, or a folder something made in its place. */
export function clearSocketPath(path: string): void {
  if (process.platform === 'win32' || !existsSync(path)) return
  if (lstatSync(path).isDirectory()) rmdirSync(path)
  else unlinkSync(path)
}

/**
 * Where browsers in a Flatpak sandbox reach this app, relative to $XDG_RUNTIME_DIR: a folder of its
 * own, which a user override shares with each such browser (browsers.ts), and in it a socket that
 * answers the extension's requests and nothing else. A folder, not the socket, so a sandbox that
 * started before this app still sees the socket it makes.
 */
export const BROWSER_SOCKET = ['maki', 'browser.sock'] as const

/** The sandboxed browsers' socket; null where there's no $XDG_RUNTIME_DIR, or no Flatpak. */
export function browserSocketPath(): string | null {
  const run = process.env['XDG_RUNTIME_DIR']
  return process.platform === 'linux' && run ? join(run, ...BROWSER_SOCKET) : null
}

export type Handler = (request: BridgeRequest) => Promise<BridgeResult>

/** The extension's requests only, as the native messaging host passes them: for the browsers' socket. */
export function extensionOnly(handler: Handler): Handler {
  return (request) =>
    (EXTENSION_REQUESTS as readonly string[]).includes(request.type)
      ? handler(request)
      : Promise.reject(new Error('not for the extension'))
}

/**
 * A request as the window takes it. `maki install` names a file, which the window can't read:
 * the bundle goes to it as bytes. maki checks it, and asks its owner, either way.
 */
export async function forWindow(request: BridgeRequest): Promise<BridgeRequest> {
  if (request.type === 'installBundle') throw new Error('malformed request')
  if (request.type !== 'install') return request
  if (!isAbsolute(request.path)) throw new Error('give the bundle’s full path')
  if ((await stat(request.path)).size > 512 * 1024)
    throw new Error('that file is bigger than any app maki takes (512 KiB)')
  return {
    id: request.id,
    type: 'installBundle',
    data: new Uint8Array(await readFile(request.path))
  }
}

/** One JSON object per line in both directions; requests may overlap. */
export async function serveBridge(handler: Handler, path?: string): Promise<Server> {
  path ??= socketPath()
  if (process.platform !== 'win32' && path.endsWith(join(...BROWSER_SOCKET))) {
    // the folder a sandbox may have made already (xdg-run/maki:create), kept to this user
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
  }
  clearSocketPath(path)
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    const send = (response: BridgeResponse): void => {
      if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n')
    }
    socket.on('data', (chunk: string) => {
      buffer += chunk
      // nothing legitimate is this big: each request checks its own size below (bridge-types)
      if (buffer.length > 1024 * 1024) return socket.destroy()
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let request: BridgeRequest | null = null
        let id = -1
        try {
          const parsed: unknown = JSON.parse(line)
          id =
            typeof (parsed as { id?: unknown })?.id === 'number'
              ? (parsed as { id: number }).id
              : -1
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
