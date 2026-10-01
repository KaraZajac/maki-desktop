import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'

/** Writes under way, by file: one at a time each, in the order they were asked for. */
const writing = new Map<string, Promise<void>>()

/**
 * Replace a file whole: written beside it, synced, then renamed over it, so a crash, a quit or
 * the update's restart midway leaves the old file or the new one, never part of either. Writes
 * to one file go one at a time, in order. Readable by this user only.
 */
export function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const next = (writing.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      const f = await open(temp, 'wx', 0o600)
      try {
        await f.writeFile(data)
        await f.sync()
        await f.close()
        await rename(temp, path)
      } catch (e) {
        await f.close().catch(() => {})
        await rm(temp, { force: true })
        throw e
      }
    })
  writing.set(path, next)
  next.then(
    () => writing.get(path) === next && writing.delete(path),
    () => writing.get(path) === next && writing.delete(path)
  )
  return next
}
