import { ext } from './api'
import { siteOf } from './site'

/**
 * The extension's link to maki desktop, over native messaging. Content scripts ask; this adds the
 * site, taken from the URL the browser reports for the asking frame (a page can't forge it), and
 * passes the request to the desktop app, which asks maki. Nothing is kept here.
 */

const HOST = 'com.leviathan.maki'
/** Hang up on the host when nothing has been asked for this long: it's a whole app process. */
const IDLE_MS = 30_000

export type Reply = { ok: boolean; error?: string } & Record<string, unknown>

let port: chrome.runtime.Port | null = null
const pending = new Map<number, (r: Reply) => void>()
let nextId = 1
let idle: ReturnType<typeof setTimeout> | undefined

function settle(id: number, reply: Reply): void {
  const done = pending.get(id)
  pending.delete(id)
  done?.(reply)
  if (pending.size === 0 && port) {
    const p = port
    idle = setTimeout(() => {
      if (port === p && pending.size === 0) {
        port = null
        p.disconnect()
      }
    }, IDLE_MS)
  }
}

function native(): chrome.runtime.Port {
  if (port) return port
  const p = ext.runtime.connectNative(HOST)
  p.onMessage.addListener((msg: Reply & { id?: unknown }) => {
    if (typeof msg.id === 'number') settle(msg.id, msg)
  })
  p.onDisconnect.addListener(() => {
    // Chrome says why in runtime.lastError, Firefox on the port
    const why = (p as { error?: { message?: string } }).error?.message ?? ext.runtime.lastError?.message
    port = null
    for (const id of [...pending.keys()]) settle(id, { ok: false, error: why ? `maki desktop unavailable (${why})` : 'maki desktop went away' })
  })
  port = p
  return p
}

function toDesktop(request: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolve) => {
    const id = nextId++
    clearTimeout(idle)
    pending.set(id, resolve)
    try {
      native().postMessage({ id, ...request })
    } catch (e) {
      settle(id, { ok: false, error: (e as Error).message })
    }
  })
}

type FromPage = { type?: unknown; username?: unknown; password?: unknown; method?: unknown; params?: unknown }

export function handle(msg: FromPage, senderUrl: string | undefined): Promise<Reply> {
  if (msg.type === 'status') return toDesktop({ type: 'status' })
  if (msg.type === 'eth') {
    // the page's Ethereum provider: the site is the browser's word, never the page's
    const site = siteOf(senderUrl)
    if (!site) return Promise.resolve({ ok: false, error: 'maki only works on https pages' })
    if (typeof msg.method !== 'string' || !Array.isArray(msg.params)) return Promise.resolve({ ok: false, error: 'unknown request' })
    return toDesktop({ type: 'eth', site, method: msg.method, params: msg.params })
  }
  if (msg.type !== 'getLogin' && msg.type !== 'getTotp' && msg.type !== 'saveLogin') {
    return Promise.resolve({ ok: false, error: 'unknown request' })
  }
  const site = siteOf(senderUrl)
  if (!site) return Promise.resolve({ ok: false, error: 'maki only works on https pages' })
  if (msg.type !== 'saveLogin') return toDesktop({ type: msg.type, site })
  if (typeof msg.username !== 'string' || typeof msg.password !== 'string') {
    return Promise.resolve({ ok: false, error: 'unknown request' })
  }
  return toDesktop({ type: 'saveLogin', site, username: msg.username, password: msg.password })
}

ext.runtime.onMessage.addListener((msg: FromPage, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id) return false
  void handle(msg, sender.url).then(sendResponse)
  return true // answering later
})
