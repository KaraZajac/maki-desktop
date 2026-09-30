import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { EXTENSION_REQUESTS } from '../shared/bridge-types'

/**
 * The native messaging host: what a browser starts when the maki extension calls connectNative.
 * Browser side: stdio, each message a 4-byte little-endian length then UTF-8 JSON. App side: the
 * bridge socket, one JSON object per line. This relays between the two and starts the tray app if
 * it isn't running. Nothing but framed messages may ever reach stdout.
 */

const MAX_FROM_BROWSER = 64 * 1024

/** Browser → us: split stdin into messages. */
export function readNativeMessages(
  input: Readable,
  onMessage: (json: string) => void,
  onEnd: () => void
): void {
  let buf = Buffer.alloc(0)
  input.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0)
      if (len > MAX_FROM_BROWSER) return onEnd()
      if (buf.length < 4 + len) break
      onMessage(buf.subarray(4, 4 + len).toString('utf8'))
      buf = buf.subarray(4 + len)
    }
  })
  input.on('end', onEnd)
  input.on('close', onEnd)
}

/** Us → browser. */
export function writeNativeMessage(output: Writable, json: string): void {
  const body = Buffer.from(json, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  output.write(Buffer.concat([head, body]))
}

function connectWithRetry(path: string, attempts: number, delayMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number): void => {
      const s = connect(path)
      s.once('connect', () => resolve(s))
      s.once('error', (e) => (left > 0 ? setTimeout(() => attempt(left - 1), delayMs) : reject(e)))
    }
    attempt(attempts)
  })
}

export interface HostOptions {
  socketPath: string
  input: Readable
  output: Writable
  /** Start the tray app when nothing is listening; omitted in tests. */
  launchApp?: () => void
  /** How long to wait for the app after launching it: 40 tries 250 ms apart by default. */
  retry?: { attempts: number; delayMs: number }
}

export async function runNativeHost({
  socketPath,
  input,
  output,
  launchApp,
  retry = { attempts: 40, delayMs: 250 }
}: HostOptions): Promise<void> {
  const failAll: string[] = [] // requests received before the app answered
  const pendingIds = new Set<number>()
  let socket: Socket | null = null
  let ended = false

  const toApp = (json: string): void => {
    try {
      const { id, type } = JSON.parse(json) as { id?: unknown; type?: unknown }
      // the extension's requests only: installing apps is for this computer's own tools
      if (!(EXTENSION_REQUESTS as readonly unknown[]).includes(type)) {
        writeNativeMessage(
          output,
          JSON.stringify({
            id: typeof id === 'number' ? id : -1,
            ok: false,
            error: 'not for the extension'
          })
        )
        return
      }
      if (typeof id === 'number') pendingIds.add(id)
    } catch {
      /* the app will reject it */
    }
    if (socket) socket.write(json.replace(/\n/g, ' ') + '\n')
    else failAll.push(json)
  }
  readNativeMessages(input, toApp, () => {
    ended = true
    socket?.end()
  })

  try {
    socket = await connectWithRetry(socketPath, 0, 0).catch(async () => {
      launchApp?.()
      return connectWithRetry(socketPath, retry.attempts, retry.delayMs)
    })
  } catch {
    for (const id of pendingIds) {
      writeNativeMessage(
        output,
        JSON.stringify({ id, ok: false, error: 'maki desktop is not running' })
      )
    }
    return
  }
  if (ended) {
    socket.end()
    return
  }
  for (const json of failAll.splice(0)) socket.write(json.replace(/\n/g, ' ') + '\n')

  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id
        if (typeof id === 'number') pendingIds.delete(id)
      } catch {
        continue
      }
      writeNativeMessage(output, line)
    }
  })
  await new Promise<void>((resolve) => socket!.on('close', () => resolve()))
  for (const id of pendingIds) {
    writeNativeMessage(output, JSON.stringify({ id, ok: false, error: 'maki desktop went away' }))
  }
}

/** How the host starts the tray app: the same executable, hidden. */
export function launchTrayApp({ exe, appPath }: { exe: string; appPath: string | null }): void {
  const args = appPath ? [appPath, '--hidden'] : ['--hidden']
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref()
}
