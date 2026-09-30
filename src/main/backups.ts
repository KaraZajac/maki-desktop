import { app, shell } from 'electron'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * maki's backups on this computer: `latest.makibak`, and one a day (`maki-YYYY-MM-DD.makibak`)
 * for a month. They're encrypted with a key from maki's recovery phrase; without the phrase
 * they're noise, so they can go wherever the owner likes (a cloud folder, a USB stick).
 */

const KEEP_DAYS = 30

export function backupDir(): string {
  return join(app.getPath('userData'), 'backups')
}

export async function saveBackup(data: Uint8Array): Promise<void> {
  const dir = backupDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'latest.makibak'), data, { mode: 0o600 })
  const day = new Date().toISOString().slice(0, 10)
  await writeFile(join(dir, `maki-${day}.makibak`), data, { mode: 0o600 })
  const daily = (await readdir(dir))
    .filter((f) => /^maki-\d{4}-\d{2}-\d{2}\.makibak$/.test(f))
    .sort()
  for (const old of daily.slice(0, Math.max(0, daily.length - KEEP_DAYS)))
    await rm(join(dir, old), { force: true })
}

export async function latestBackup(): Promise<Uint8Array | null> {
  return readFile(join(backupDir(), 'latest.makibak')).then(
    (b) => new Uint8Array(b),
    () => null
  )
}

export async function backupInfo(): Promise<{ at: number; bytes: number } | null> {
  return stat(join(backupDir(), 'latest.makibak')).then(
    (s) => ({ at: s.mtimeMs, bytes: s.size }),
    () => null
  )
}

export async function showBackups(): Promise<void> {
  await mkdir(backupDir(), { recursive: true, mode: 0o700 })
  await shell.openPath(backupDir())
}
