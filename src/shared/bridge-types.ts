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

export type BridgeResult =
  | { type: 'status'; linked: boolean; timeState: number | null }
  | { type: 'getLogin'; approval: string; username: string; password: string }
  | { type: 'getTotp'; approval: string; code: string; validForS: number }
  | { type: 'saveLogin'; approval: string }

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
