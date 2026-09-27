/**
 * Where the maki store's files come from, in the main process: the store's address (https, or
 * http on this computer for development), or a folder, for development and tests. Only paths
 * inside the store: nothing the renderer asks for reaches anything else.
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { STORE_PATH, type StoreSource } from '../shared/store'

/** The biggest file a store has: a bundle, at most 512 KiB, with room to spare. */
export const MAX_STORE_FILE = 1024 * 1024

/**
 * Where the store is: MAKI_STORE (an address or a folder), or nowhere until the real store
 * opens, for now.
 */
export function storeWhere(env: NodeJS.ProcessEnv = process.env): string | null {
  return env['MAKI_STORE']?.trim() || null
}

function remote(where: string): URL | null {
  if (!/^[a-z]+:\/\//i.test(where)) return null
  const url = new URL(where.endsWith('/') ? where : `${where}/`)
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !local) throw new Error('the maki store must be on https (or http on this computer)')
  return url
}

export function storeSource(where: string): StoreSource {
  const base = remote(where)
  return {
    async get(path: string): Promise<Uint8Array | null> {
      if (!STORE_PATH.test(path)) throw new Error(`not a store path: ${path}`)
      if (base) {
        const r = await fetch(new URL(path, base), { redirect: 'error' })
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
