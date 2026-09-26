import { createSocket } from 'node:dgram'

const MAGIC = 'ROUGHTIM'

/**
 * Carry one Roughtime request, built by maki, to a server and bring back the answer. The badge
 * verifies everything; this only moves bytes. It still refuses to send anything that isn't a
 * 1024-byte Roughtime request to the Roughtime port, so it can't be turned into a general UDP
 * sender.
 */
export function relay(host: string, port: number, packet: Uint8Array, timeoutMs = 3000): Promise<Uint8Array> {
  if (
    packet.length !== 1024 ||
    new TextDecoder().decode(packet.subarray(0, 8)) !== MAGIC ||
    port !== 2002 ||
    !/^[a-z0-9.-]+$/i.test(host)
  ) {
    return Promise.reject(new Error('not a Roughtime request'))
  }
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      socket.close()
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error(`${host}: no answer`))), timeoutMs)
    socket.once('message', (msg) => done(() => resolve(new Uint8Array(msg))))
    socket.once('error', (err) => done(() => reject(err)))
    socket.send(packet, port, host)
  })
}
