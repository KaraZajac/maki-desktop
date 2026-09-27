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

export type BridgeResponse = ({ id: number; ok: true } & BridgeResult) | { id: number; ok: false; error: string }

/** Everything the app accepts, checked field by field: the socket is reachable by any local process. */
export function parseRequest(value: unknown): BridgeRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const str = (k: string, max = 255): string | null =>
    typeof v[k] === 'string' && (v[k] as string).length <= max ? (v[k] as string) : null
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
