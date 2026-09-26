import type { Link } from '@shared/link'
import { isMaki, MAKI_USB, SerialTransport } from './transports'

/** Ports that answered HELLO wrongly or not at all: most likely a stock DC34 badge. Never retried. */
const notMaki = new WeakSet<SerialPort>()

async function tryPort(link: Link, port: SerialPort): Promise<void> {
  if (link.busy || notMaki.has(port) || !isMaki(port)) return
  let transport: SerialTransport
  try {
    transport = await SerialTransport.open(port)
  } catch {
    return // held by something else
  }
  if (!(await link.attach(transport, 'USB', { probe: true }))) {
    notMaki.add(port)
    link.note('a Baochip device on USB didn’t answer as maki (stock DC34 firmware?); leaving it alone')
  }
}

/** Link to any permitted maki now, and to any plugged in later. Returns a stop function. */
export function watchUsb(link: Link): () => void {
  const scan = (): void =>
    void navigator.serial.getPorts().then(async (ports) => {
      for (const p of ports) await tryPort(link, p)
    })
  scan()
  const onConnect = (e: Event): void => void tryPort(link, e.target as SerialPort)
  navigator.serial.addEventListener('connect', onConnect)
  // look again when a link ends, in case another maki is waiting
  const unsubscribe = link.subscribe(() => {
    if (!link.state.linked && !link.busy) scan()
  })
  return () => {
    navigator.serial.removeEventListener('connect', onConnect)
    unsubscribe()
  }
}

/** Ask the user to pick maki (needs a click), which also grants permission for next time. */
export async function chooseUsb(link: Link): Promise<void> {
  try {
    await tryPort(link, await navigator.serial.requestPort({ filters: [MAKI_USB] }))
  } catch (e) {
    link.note(`no maki chosen: ${(e as Error).message}`)
  }
}
