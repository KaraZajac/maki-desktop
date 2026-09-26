import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A stand-in for the browser: records what goes to the native host, delivers what comes back. */
function fakeBrowser() {
  const sent: Record<string, unknown>[] = []
  const toPage: ((m: unknown) => void)[] = []
  const disconnect: (() => void)[] = []
  let listener: (msg: unknown, sender: { id?: string; url?: string }, respond: (r: unknown) => void) => boolean = () => false
  let connections = 0
  let hangups = 0
  const chrome = {
    runtime: {
      id: 'maki',
      lastError: undefined as { message: string } | undefined,
      connectNative: () => {
        connections++
        return {
          postMessage: (m: Record<string, unknown>) => sent.push(m),
          onMessage: { addListener: (f: (m: unknown) => void) => toPage.push(f) },
          onDisconnect: { addListener: (f: () => void) => disconnect.push(f) },
          disconnect: () => hangups++
        }
      },
      onMessage: { addListener: (f: typeof listener) => (listener = f) }
    }
  }
  return {
    chrome,
    sent,
    connections: () => connections,
    hangups: () => hangups,
    /** a message from a page, as the browser would deliver it */
    fromPage: (msg: unknown, url: string, id = 'maki'): { handled: boolean; reply: Promise<Record<string, unknown>> } => {
      let respond!: (r: Record<string, unknown>) => void
      const reply = new Promise<Record<string, unknown>>((r) => (respond = r))
      return { handled: listener(msg, { id, url }, respond as (r: unknown) => void), reply }
    },
    fromHost: (m: unknown) => toPage.forEach((f) => f(m)),
    hostExits: (why?: string) => {
      chrome.runtime.lastError = why ? { message: why } : undefined
      disconnect.forEach((f) => f())
    }
  }
}

let b: ReturnType<typeof fakeBrowser>
beforeEach(async () => {
  vi.resetModules()
  b = fakeBrowser()
  vi.stubGlobal('chrome', b.chrome)
  await import('./background')
})

describe('background', () => {
  it('names the site from the frame the browser says asked, and relays the answer', async () => {
    const { handled, reply } = b.fromPage({ type: 'getLogin', site: 'evil.example' }, 'https://gist.github.com/login?next=/')
    expect(handled).toBe(true)
    expect(b.sent).toEqual([{ id: 1, type: 'getLogin', site: 'gist.github.com' }]) // a page can't pick the site
    b.fromHost({ id: 1, ok: true, type: 'getLogin', approval: 'approved', username: 'kara', password: 'pw' })
    expect(await reply).toMatchObject({ ok: true, approval: 'approved', username: 'kara' })
  })

  it.each(['http://example.com/', 'file:///home/kara/login.html', 'about:blank', 'chrome-extension://abc/popup.html'])(
    'refuses %s without asking maki',
    async (url) => {
      expect(await b.fromPage({ type: 'getTotp' }, url).reply).toEqual({ ok: false, error: 'maki only works on https pages' })
      expect(b.connections()).toBe(0)
    }
  )

  it('allows localhost over http, for development', async () => {
    b.fromPage({ type: 'getTotp' }, 'http://localhost:5173/')
    expect(b.sent).toEqual([{ id: 1, type: 'getTotp', site: 'localhost' }])
  })

  it('ignores other extensions', () => {
    expect(b.fromPage({ type: 'getLogin' }, 'https://github.com/', 'someone-else').handled).toBe(false)
    expect(b.connections()).toBe(0)
  })

  it('checks what a page offers to save', async () => {
    expect(await b.fromPage({ type: 'saveLogin', username: 1, password: 'pw' }, 'https://github.com/').reply).toMatchObject({ ok: false })
    b.fromPage({ type: 'saveLogin', username: 'kara', password: 'pw' }, 'https://github.com/')
    expect(b.sent).toEqual([{ id: 1, type: 'saveLogin', site: 'github.com', username: 'kara', password: 'pw' }])
  })

  it('hangs up on the host once nothing has been asked for a while', async () => {
    vi.useFakeTimers()
    try {
      b.fromPage({ type: 'getLogin' }, 'https://github.com/')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(b.hangups()).toBe(0) // still waiting on maki
      b.fromHost({ id: 1, ok: true, type: 'getLogin', approval: 'denied', username: '', password: '' })
      await vi.advanceTimersByTimeAsync(20_000)
      b.fromPage({ type: 'status' }, 'chrome-extension://maki/popup.html') // resets the clock
      b.fromHost({ id: 2, ok: true, type: 'status', linked: true, timeState: 2 })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(b.hangups()).toBe(0)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(b.hangups()).toBe(1)
      b.fromPage({ type: 'status' }, 'chrome-extension://maki/popup.html')
      expect(b.connections()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers everything waiting when the host goes away, then reconnects', async () => {
    const one = b.fromPage({ type: 'getLogin' }, 'https://github.com/').reply
    const two = b.fromPage({ type: 'status' }, 'chrome-extension://maki/popup.html').reply
    b.hostExits('Native host has exited.')
    expect(await one).toEqual({ ok: false, error: 'maki desktop unavailable (Native host has exited.)' })
    expect(await two).toMatchObject({ ok: false })
    b.fromPage({ type: 'status' }, 'chrome-extension://maki/popup.html')
    expect(b.connections()).toBe(2)
  })
})
