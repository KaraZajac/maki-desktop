/**
 * Finding maki on USB: a port that doesn't answer at first (maki still booting) is tried again,
 * and one plugged in again starts afresh. Web Serial and the link are stand-ins here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Link } from '@shared/link'
import { disconnect, watchUsb } from './usb'

vi.mock('./transports', () => ({
  MAKI_USB: { usbVendorId: 0x1d50, usbProductId: 0x6198 },
  isMaki: () => true,
  SerialTransport: { open: async (port: unknown) => ({ port }) }
}))

/** Web Serial: the ports it lists, and its connect and disconnect events, fired by hand. */
function fakeSerial(): {
  ports: object[]
  fire: (type: 'connect' | 'disconnect', port: object) => void
} {
  const listeners = new Map<string, ((e: Event) => void)[]>()
  const ports: object[] = []
  const serial = {
    getPorts: async () => [...ports],
    addEventListener: (type: string, f: (e: Event) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), f]),
    removeEventListener: (type: string, f: (e: Event) => void) =>
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((g) => g !== f)
      )
  }
  vi.stubGlobal('navigator', { serial })
  return {
    ports,
    fire: (type, port) => {
      for (const f of listeners.get(type) ?? []) f({ target: port } as unknown as Event)
    }
  }
}

/** The link: it links once `answersAfter` attempts have gone unanswered, then stays linked. */
function fakeLink(answersAfter: number): Link & { attempts: number; notes: string[] } {
  const link = {
    attempts: 0,
    notes: [] as string[],
    busy: false,
    state: { linked: false },
    attach: async () => {
      link.attempts++
      if (link.attempts <= answersAfter) return false
      link.state.linked = true
      link.busy = true
      return true
    },
    note: (line: string) => void link.notes.push(line),
    subscribe: () => () => {},
    drop: async () => {
      link.state.linked = false
      link.busy = false
    }
  }
  return link as unknown as Link & { attempts: number; notes: string[] }
}

describe('finding maki on USB', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('tries a port that showed up before maki answers again, until it does', async () => {
    const serial = fakeSerial()
    const link = fakeLink(3) // maki answers the fourth HELLO
    const stop = watchUsb(link)
    const port = {}
    serial.ports.push(port)
    serial.fire('connect', port)
    await vi.advanceTimersByTimeAsync(0)
    expect(link.attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(link.attempts).toBe(4)
    expect(link.state.linked).toBe(true)
    expect(link.notes).toEqual([])
    stop()
  })

  it('leaves a port alone after a minute of no answer, until it is plugged in again', async () => {
    const serial = fakeSerial()
    const link = fakeLink(Infinity) // a stock badge: never answers as maki
    const stop = watchUsb(link)
    const port = {}
    serial.ports.push(port)
    serial.fire('connect', port)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(link.attempts).toBe(20)
    expect(link.notes).toHaveLength(1)
    expect(link.notes[0]).toMatch(/didn’t answer as maki/)
    // the periodic look doesn't try it again
    await vi.advanceTimersByTimeAsync(60_000)
    expect(link.attempts).toBe(20)
    // plugged in again: a fresh start
    serial.fire('disconnect', port)
    serial.fire('connect', port)
    await vi.advanceTimersByTimeAsync(0)
    expect(link.attempts).toBe(21)
    stop()
  })

  it('stays unlinked after Disconnect, until maki is plugged in again', async () => {
    const serial = fakeSerial()
    const link = fakeLink(0)
    const stop = watchUsb(link)
    const port = {}
    serial.ports.push(port)
    serial.fire('connect', port)
    await vi.advanceTimersByTimeAsync(0)
    expect(link.state.linked).toBe(true)
    disconnect(link)
    await vi.advanceTimersByTimeAsync(0)
    expect(link.state.linked).toBe(false)
    // the periodic look leaves it alone
    await vi.advanceTimersByTimeAsync(30_000)
    expect(link.attempts).toBe(1)
    expect(link.state.linked).toBe(false)
    // plugged in again
    serial.fire('disconnect', port)
    serial.fire('connect', port)
    await vi.advanceTimersByTimeAsync(0)
    expect(link.attempts).toBe(2)
    expect(link.state.linked).toBe(true)
    stop()
  })

  it('finds a maki that was plugged in without a connect event, by looking every few seconds', async () => {
    const serial = fakeSerial()
    const link = fakeLink(0)
    const stop = watchUsb(link)
    await vi.advanceTimersByTimeAsync(0)
    expect(link.attempts).toBe(0)
    serial.ports.push({})
    await vi.advanceTimersByTimeAsync(5_000)
    expect(link.attempts).toBe(1)
    expect(link.state.linked).toBe(true)
    stop()
  })
})
