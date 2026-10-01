import type { Link } from '@shared/link'
import { isMaki, MAKI_USB, SerialTransport } from './transports'

/**
 * A port that didn't answer HELLO is tried again for a while before it's taken for something
 * else (a stock DC34 badge, which shares maki's USB IDs): a badge just plugged in shows up on
 * USB before its link is up, and the port itself may not open until the system has set it up.
 */
const RETRY_MS = 3_000
const TRIES = 20
/** How often to look for a maki while none is linked, for a 'connect' that never came. */
const SCAN_MS = 5_000

/** How often each port has failed to link; one that reaches TRIES is left alone. */
const failures = new WeakMap<SerialPort, number>()
/** Ports being tried, or waiting to be tried again: one attempt at a time, at its own pace. */
const trying = new WeakSet<SerialPort>()

async function tryPort(link: Link, port: SerialPort): Promise<void> {
  if (link.busy || !isMaki(port) || trying.has(port) || (failures.get(port) ?? 0) >= TRIES) return
  trying.add(port)
  let linked = false
  try {
    linked = await link.attach(await SerialTransport.open(port), 'USB', { probe: true })
  } catch {
    // held by something else, or not ready yet
  }
  if (linked || link.state.linked) {
    // linked, or another maki got there first
    if (linked) failures.delete(port)
    trying.delete(port)
    return
  }
  const n = (failures.get(port) ?? 0) + 1
  failures.set(port, n)
  if (n >= TRIES) {
    trying.delete(port)
    link.note(
      'a Baochip device on USB didn’t answer as maki (stock DC34 firmware?); leaving it alone'
    )
    return
  }
  setTimeout(() => {
    trying.delete(port)
    void tryPort(link, port)
  }, RETRY_MS)
}

/** Link to any permitted maki now, and to any plugged in later. Returns a stop function. */
export function watchUsb(link: Link): () => void {
  const scan = (): void =>
    void navigator.serial.getPorts().then(async (ports) => {
      for (const p of ports) await tryPort(link, p)
    })
  scan()
  // plugged in (again): a fresh start for the port
  const onConnect = (e: Event): void => {
    failures.delete(e.target as SerialPort)
    void tryPort(link, e.target as SerialPort)
  }
  const onDisconnect = (e: Event): void => void failures.delete(e.target as SerialPort)
  navigator.serial.addEventListener('connect', onConnect)
  navigator.serial.addEventListener('disconnect', onDisconnect)
  const looking = setInterval(() => {
    if (!link.state.linked && !link.busy) scan()
  }, SCAN_MS)
  // look again when a link ends, in case another maki is waiting
  const unsubscribe = link.subscribe(() => {
    if (!link.state.linked && !link.busy) scan()
  })
  return () => {
    navigator.serial.removeEventListener('connect', onConnect)
    navigator.serial.removeEventListener('disconnect', onDisconnect)
    clearInterval(looking)
    unsubscribe()
  }
}

/** Ask the user to pick maki (needs a click), which also grants permission for next time. */
export async function chooseUsb(link: Link): Promise<void> {
  try {
    const port = await navigator.serial.requestPort({ filters: [MAKI_USB] })
    failures.delete(port) // picked by hand: tried afresh
    await tryPort(link, port)
  } catch (e) {
    link.note(`no maki chosen: ${(e as Error).message}`)
  }
}
