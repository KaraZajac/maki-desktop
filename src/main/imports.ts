/**
 * Exports from other password managers, for the Logins & passkeys page: chosen in an open dialog,
 * read here and handed to the window (a big one, a zip with attachments, a range at a time), and,
 * once imported, moved to the trash if the owner says so. They hold passwords in the clear, so
 * nothing of them is written anywhere, and only files the owner chose can be read or moved: the
 * window names them by an ID of this session's, never by a path.
 */
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, delimiter } from 'node:path'

/** A file this size or smaller goes to the window whole; a bigger one, a range at a time. */
export const WHOLE = 32 * 1024 * 1024
/** The biggest export opened at all: a zip with years of attachments, of which only the data is read. */
export const BIGGEST = 4 * 1024 * 1024 * 1024

/** An export chosen, as the window has it. */
export interface Chosen {
  id: number
  name: string
  size: number
  /** its bytes, unless it's bigger than `WHOLE` */
  data: Uint8Array | null
}

/**
 * Serves the window's `imports` calls. `offscreen` (the UI tests) takes the files from
 * MAKI_OFFSCREEN_OPEN (paths, separated as PATH's are) in place of a dialog no one would see.
 */
export function serveImports(window: () => BrowserWindow | null, offscreen: boolean): void {
  const chosen = new Map<number, string>()
  let next = 1

  ipcMain.handle('imports:open', async (): Promise<Chosen[] | null> => {
    let paths: string[]
    const fixed = offscreen ? process.env['MAKI_OFFSCREEN_OPEN'] : undefined
    if (fixed) paths = fixed.split(delimiter).filter((p) => p !== '')
    else {
      const win = window()
      const options: Electron.OpenDialogOptions = {
        title: 'Choose an export from another password manager',
        filters: [
          { name: 'Exports', extensions: ['csv', 'json', 'zip', '1pux', 'xml'] },
          { name: 'All files', extensions: ['*'] }
        ],
        properties: ['openFile', 'multiSelections']
      }
      const r = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (r.canceled || r.filePaths.length === 0) return null
      paths = r.filePaths
    }
    const out: Chosen[] = []
    for (const path of paths) {
      const size = (await stat(path)).size
      if (size > BIGGEST) throw new Error(`${basename(path)} is too big to be an export`)
      const id = next++
      chosen.set(id, path)
      out.push({
        id,
        name: basename(path),
        size,
        data: size <= WHOLE ? new Uint8Array(await readFile(path)) : null
      })
    }
    return out
  })

  ipcMain.handle('imports:read', async (_e, id: unknown, offset: unknown, length: unknown) => {
    const path = typeof id === 'number' ? chosen.get(id) : undefined
    if (!path) throw new Error('that file wasn’t chosen to import')
    if (
      typeof offset !== 'number' ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > WHOLE
    )
      throw new Error('that isn’t a range of the file')
    const file = await open(path, 'r')
    try {
      const bytes = new Uint8Array(length)
      const { bytesRead } = await file.read(bytes, 0, length, offset)
      return bytesRead === length ? bytes : bytes.slice(0, bytesRead)
    } finally {
      await file.close()
    }
  })

  // to the trash, where the owner can still take it back from; what couldn't be moved, and why
  ipcMain.handle('imports:trash', async (_e, ids: unknown) => {
    const failed: { name: string; why: string }[] = []
    for (const id of Array.isArray(ids) ? ids : []) {
      const path = typeof id === 'number' ? chosen.get(id) : undefined
      if (!path) continue
      try {
        await shell.trashItem(path)
        chosen.delete(id)
      } catch (e) {
        failed.push({ name: basename(path), why: (e as Error).message })
      }
    }
    return failed
  })

  ipcMain.handle('imports:forget', (_e, ids: unknown) => {
    for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'number') chosen.delete(id)
  })
}
