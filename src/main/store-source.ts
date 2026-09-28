/**
 * Where the maki store's files come from, in the main process: the store's address (https, or
 * http on this computer for development), or a folder, for development and tests. Only paths
 * inside the store: nothing the renderer asks for reaches anything else.
 *
 * The store is published from its Git repository (KaraZajac/maki-apps, its store/ folder). While
 * that repository is private, reading it takes a GitHub token, MAKI_STORE_TOKEN, which goes to
 * GitHub's file server and nowhere else.
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { STORE_PATH, type StoreSource } from '../shared/store'

/** The biggest file a store has: a bundle, at most 512 KiB, with room to spare. */
export const MAX_STORE_FILE = 1024 * 1024

/** The maki store, as its repository publishes it. */
export const STORE = 'https://raw.githubusercontent.com/KaraZajac/maki-apps/main/store/'

/** GitHub's file server: the only place a token for the store's repository goes. */
const GITHUB_FILES = 'raw.githubusercontent.com'

/** Where the store is: MAKI_STORE (an address or a folder), or the maki store. */
export function storeWhere(env: NodeJS.ProcessEnv = process.env): string {
  return env['MAKI_STORE']?.trim() || STORE
}

/** A token to read the store's repository while it's private: MAKI_STORE_TOKEN. */
export function storeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env['MAKI_STORE_TOKEN']?.trim() || null
}

/** Whether the store is on GitHub's file server, where a private repository answers 404 to everyone else. */
export function onGithub(where: string): boolean {
  return where.startsWith(`https://${GITHUB_FILES}/`)
}

/**
 * The store's name as people know it: the repository for GitHub's file server, the host for
 * another address, the folder's path otherwise.
 */
export function storeName(where: string): string {
  const github = where.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//)
  if (github) return `${github[1]}/${github[2]}`
  if (/^[a-z]+:\/\//i.test(where)) return new URL(where).host
  return where
}

function remote(where: string): URL | null {
  if (!/^[a-z]+:\/\//i.test(where)) return null
  const url = new URL(where.endsWith('/') ? where : `${where}/`)
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !local) throw new Error('the maki store must be on https (or http on this computer)')
  return url
}

export function storeSource(where: string, token: string | null = null): StoreSource {
  const base = remote(where)
  const headers: Record<string, string> =
    base && token && base.protocol === 'https:' && base.hostname === GITHUB_FILES ? { authorization: `token ${token}` } : {}
  return {
    async get(path: string): Promise<Uint8Array | null> {
      if (!STORE_PATH.test(path)) throw new Error(`not a store path: ${path}`)
      if (base) {
        const r = await fetch(new URL(path, base), { redirect: 'error', headers, signal: AbortSignal.timeout(30_000) })
        if (r.status === 404) return null
        if (!r.ok) throw new Error(`the maki store answered ${r.status} for ${path}`)
        const length = Number(r.headers.get('content-length') ?? 0)
        if (length > MAX_STORE_FILE) throw new Error(`${path} from the maki store is too big`)
        const body = new Uint8Array(await r.arrayBuffer())
        if (body.length > MAX_STORE_FILE) throw new Error(`${path} from the maki store is too big`)
        return body
      }
      const file = join(resolve(where), ...path.split('/'))
      try {
        if ((await stat(file)).size > MAX_STORE_FILE) throw new Error(`${path} in the maki store is too big`)
        return new Uint8Array(await readFile(file))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    }
  }
}
