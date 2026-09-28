/**
 * What the browser extension can ask the desktop app, and what it gets back. JSON, one object per
 * message: length-prefixed over native messaging (browser ⇄ host), one per line over the local
 * socket (host ⇄ app).
 */

export type BridgeRequest =
  | { id: number; type: 'status' }
  | { id: number; type: 'getLogin'; site: string }
  | { id: number; type: 'getTotp'; site: string }
  | { id: number; type: 'saveLogin'; site: string; username: string; password: string }
  | { id: number; type: 'eth'; site: string; method: string; params: unknown[] }
  /** from `maki install` on this computer, never the extension: a .maki file to install */
  | { id: number; type: 'install'; path: string }
  /** the same, once the main process has read the file: to the window only */
  | { id: number; type: 'installBundle'; data: Uint8Array }
  /**
   * a message for an app on maki with the link permission (base64 over the socket), from software
   * on this computer, never the extension; maki desktop's SSH agent sends these to maki's SSH app
   */
  | { id: number; type: 'appMessage'; app: string; data: Uint8Array }

/** What the browser extension may ask: the native messaging host passes on nothing else. */
export const EXTENSION_REQUESTS = ['status', 'getLogin', 'getTotp', 'saveLogin', 'eth'] as const

export type BridgeResult =
  | { type: 'status'; linked: boolean; timeState: number | null }
  | { type: 'getLogin'; approval: string; username: string; password: string }
  | { type: 'getTotp'; approval: string; code: string; validForS: number }
  | { type: 'saveLogin'; approval: string }
  /** an EIP-1193 answer: the result, or the error the page's promise rejects with */
  | { type: 'eth'; result?: unknown; error?: { code: number; message: string } }
  | { type: 'install'; name: string; approval: string; reason: string }
  /** the app's answer, base64, when `status` is 'approved' */
  | { type: 'appMessage'; status: string; data: string }

export type BridgeResponse = ({ id: number; ok: true } & BridgeResult) | { id: number; ok: false; error: string }

/** maki's SSH app (the SDK's example `ssh`), which maki desktop's SSH agent talks to. */
export const SSH_APP = 'com.leviathan.maki.ssh'

/** An app ID as bundles have them: reverse-DNS, lower case. */
export const APP_ID = /^(?=.{3,64}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** null if it isn't base64. */
export function fromBase64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null
  const bin = atob(s)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/**
 * The site maki desktop is, to maki, for its own wallet's sends: a hostname no website can have
 * (.maki is no top-level domain), and one the bridge refuses from anything else.
 */
export const WALLET_SITE = 'desktop.maki'

/** Everything the app accepts, checked field by field: the socket is reachable by any local process. */
export function parseRequest(value: unknown): BridgeRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const str = (k: string, max = 255): string | null => {
    const s = typeof v[k] === 'string' && (v[k] as string).length <= max ? (v[k] as string) : null
    // no page speaks for maki desktop's own wallet
    return k === 'site' && s !== null && (s === 'maki' || s.endsWith('.maki')) ? null : s
  }
  if (typeof v.id !== 'number' || !Number.isInteger(v.id)) return null
  const id = v.id
  switch (v.type) {
    case 'status':
      return { id, type: 'status' }
    case 'getLogin':
    case 'getTotp': {
      const site = str('site', 253)
      return site === null ? null : { id, type: v.type, site }
    }
    case 'eth': {
      const site = str('site', 253)
      const method = str('method', 64)
      if (site === null || method === null || !/^[A-Za-z0-9_]+$/.test(method)) return null
      const params = v.params === undefined ? [] : v.params
      // a transaction's data can be long; nothing a page sends needs more than this
      if (!Array.isArray(params) || JSON.stringify(params).length > 512 * 1024) return null
      return { id, type: 'eth', site, method, params }
    }
    case 'install': {
      const path = str('path', 4096)
      return path === null ? null : { id, type: 'install', path }
    }
    case 'appMessage': {
      const app = str('app', 64)
      const data = str('data', 8192)
      const bytes = data === null ? null : fromBase64(data)
      if (app === null || !APP_ID.test(app) || bytes === null || bytes.length > 4096) return null
      return { id, type: 'appMessage', app, data: bytes }
    }
    case 'saveLogin': {
      const site = str('site', 253)
      const username = str('username')
      const password = str('password')
      return site === null || username === null || password === null ? null : { id, type: 'saveLogin', site, username, password }
    }
    default:
      return null
  }
}

/** A browser the extension can be connected through, as the settings list it. */
export interface BrowserStatus {
  name: string
  registered: boolean
  /** setting it up asks for an admin password */
  system: boolean
}
