/**
 * Updates, in the main process: the files of a release, fetched and checked against the size
 * and SHA-256 the maki store signed for them (shared/releases.ts); maki's new firmware put on its
 * update drive; and maki desktop's own AppImage replaced.
 *
 * maki's firmware goes on in its boot stage's update mode. maki restarts there once its owner
 * says yes (UPDATE_MODE, which the window asks over the link), and boot1 shows a USB drive,
 * BAOCHIP (1d50:6196), that takes .uf2 files, with a serial console beside it. Here: wait for the
 * drive, mount it if the desktop hasn't, copy loader.uf2, xous.uf2 and swap.uf2 onto it, each
 * synced (boot1 acknowledges a write only once it's in flash), then on the console turn boot1's
 * bootwait flag off and boot the new firmware. Linux only, for now.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { FIRMWARE_FILES, type FirmwareStep, type ReleaseFile } from '../shared/releases'

/** What reaches outside, replaced in tests. */
export interface UpdatesEnv {
  fetch: typeof fetch
  /** /sys */
  sys: string
  /** /dev */
  dev: string
  /** /proc/self/mounts */
  mounts: string
  /** `udisksctl ARGS…`, its output */
  udisksctl: (args: string[]) => Promise<string>
  /** `stty -F TTY ARGS…` */
  stty: (tty: string, args: string[]) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((ok, fail) =>
    execFile(cmd, args, { timeout: 30_000 }, (e, out, err) =>
      e ? fail(new Error(String(err).trim() || e.message)) : ok(String(out))
    )
  )

export const linuxEnv: UpdatesEnv = {
  fetch: (...a) => fetch(...a),
  sys: '/sys',
  dev: '/dev',
  mounts: '/proc/self/mounts',
  udisksctl: (args) => run('udisksctl', args),
  stty: async (tty, args) => void (await run('stty', ['-F', tty, ...args])),
  sleep: (ms) => new Promise((ok) => setTimeout(ok, ms))
}

/** maki's update mode, as boot1 shows it on USB. */
const UPDATE_USB = { vendor: '1d50', product: '6196' }
const DRIVE_LABEL = 'BAOCHIP'

// ---- downloads ----

/**
 * Fetch `file` to `dest`, checking it against the size and SHA-256 the store signed for it as it
 * comes: a file that's any bigger stops there, and one that isn't right is deleted. https only,
 * redirects included (GitHub's releases redirect to its file servers).
 */
export async function download(
  file: ReleaseFile,
  dest: string,
  env: Pick<UpdatesEnv, 'fetch'> = linuxEnv,
  progress: (bytes: number) => void = () => {}
): Promise<void> {
  const part = `${dest}.part`
  await mkdir(dirname(dest), { recursive: true })
  const r = await env.fetch(file.url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
  if (!r.ok) throw new Error(`${file.name}: the download answered ${r.status}`)
  if (r.url && !r.url.startsWith('https://')) throw new Error(`${file.name}: not over https`)
  if (!r.body) throw new Error(`${file.name}: nothing came`)
  const hash = createHash('sha256')
  const out = await open(part, 'w')
  let got = 0
  try {
    const reader = r.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
      if (got > file.bytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`${file.name}: bigger than the store says it is`)
      }
      hash.update(value)
      await out.write(value)
      progress(got)
    }
    await out.sync()
  } catch (e) {
    await out.close().catch(() => {})
    await rm(part, { force: true })
    throw e
  }
  await out.close()
  const sha256 = hash.digest('hex')
  if (got !== file.bytes || sha256 !== file.sha256) {
    await rm(part, { force: true })
    throw new Error(`${file.name} isn’t what the maki store signed for: not taken`)
  }
  await rename(part, dest)
}

/** A file already in the cache, if it's the one the store signed for. */
async function cached(file: ReleaseFile, path: string): Promise<boolean> {
  const bytes = await readFile(path).catch(() => null)
  return (
    !!bytes &&
    bytes.length === file.bytes &&
    createHash('sha256').update(bytes).digest('hex') === file.sha256
  )
}

/** The release's files in `dir` (fetched unless they're there already): their paths by name. */
export async function fetchRelease(
  files: ReleaseFile[],
  dir: string,
  env: Pick<UpdatesEnv, 'fetch'> = linuxEnv,
  progress: (name: string, bytes: number, of: number) => void = () => {}
): Promise<Record<string, string>> {
  const paths: Record<string, string> = {}
  for (const f of files) {
    const path = join(dir, f.name)
    if (!(await cached(f, path))) await download(f, path, env, (b) => progress(f.name, b, f.bytes))
    progress(f.name, f.bytes, f.bytes)
    paths[f.name] = path
  }
  return paths
}

// ---- maki's update mode ----

/**
 * The USB device a tty or block device (a partition too) belongs to: its folder in /sys, the
 * first one up from it with an idVendor (past the interface, and a disk's SCSI layers).
 */
async function usbDevice(env: UpdatesEnv, classDir: string, name: string): Promise<string | null> {
  try {
    let dir = await realpath(join(env.sys, 'class', classDir, name))
    for (let i = 0; i < 16 && dir.startsWith(env.sys) && dir !== env.sys; i++) {
      const vendor = await readFile(join(dir, 'idVendor'), 'utf8').catch(() => null)
      if (vendor !== null) return dir
      dir = dirname(dir)
    }
  } catch {
    // not there
  }
  return null
}

async function isUpdateMode(dir: string | null): Promise<boolean> {
  if (!dir) return false
  const [v, p] = await Promise.all(
    ['idVendor', 'idProduct'].map((f) =>
      readFile(join(dir, f), 'utf8').then(
        (s) => s.trim(),
        () => ''
      )
    )
  )
  return v === UPDATE_USB.vendor && p === UPDATE_USB.product
}

/** maki's update drive, if it's there: its block device (/dev/sdb). */
export async function updateDrive(env: UpdatesEnv = linuxEnv): Promise<string | null> {
  const byLabel = join(env.dev, 'disk', 'by-label', DRIVE_LABEL)
  const target = await readlink(byLabel).catch(() => null)
  if (!target) return null
  const device = resolve(dirname(byLabel), target)
  // the label alone could be anyone's: it must be maki's boot1
  return (await isUpdateMode(await usbDevice(env, 'block', basename(device)))) ? device : null
}

/** Where a block device is mounted, from the mount table. */
async function mountpoint(device: string, env: UpdatesEnv): Promise<string | null> {
  const table = await readFile(env.mounts, 'utf8').catch(() => '')
  for (const line of table.split('\n')) {
    const [dev, at] = line.split(' ')
    // the table escapes spaces and the like as octal: \040
    if (dev === device && at)
      return at.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)))
  }
  return null
}

/** maki's update console: the tty of boot1's USB device. */
export async function updateConsole(env: UpdatesEnv = linuxEnv): Promise<string | null> {
  const ttys = await readdir(join(env.sys, 'class', 'tty')).catch(() => [] as string[])
  for (const t of ttys.filter((n) => /^ttyACM\d+$/.test(n)).sort()) {
    if (await isUpdateMode(await usbDevice(env, 'tty', t))) return join(env.dev, t)
  }
  return null
}

/** Poll for something until it's there, or time's up. */
async function waitFor<T>(
  what: () => Promise<T | null>,
  ms: number,
  env: UpdatesEnv
): Promise<T | null> {
  for (let waited = 0; ; waited += 500) {
    const v = await what()
    if (v !== null || waited >= ms) return v
    await env.sleep(500)
  }
}

/** Copy a file, synced: on maki's drive, synced means written into its flash. */
async function copySynced(from: string, to: string): Promise<void> {
  const data = await readFile(from)
  const out = await open(to, 'w')
  try {
    await out.write(data)
    await out.sync()
  } finally {
    await out.close()
  }
}

/** Say a line to boot1's console, which takes a carriage return as the end of a command. */
async function say(tty: string, line: string, env: UpdatesEnv): Promise<void> {
  // not as this process's terminal, and not waiting for a carrier that a USB console hasn't
  const fd = await open(
    tty,
    constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK | constants.O_APPEND
  )
  try {
    // raw, and no echo: Linux would otherwise send boot1's own echo back to it as typing
    await env.stty(tty, ['raw', '-echo'])
    await fd.write(`${line}\r`)
  } finally {
    await fd.close().catch(() => {})
  }
}

/**
 * Put new firmware on maki in its update mode (`paths`: loader.uf2, xous.uf2, swap.uf2), and
 * start it. Waits up to `waitMs` for maki to show up there.
 */
export async function installFirmware(
  paths: Record<string, string>,
  step: (s: FirmwareStep, detail?: string) => void,
  env: UpdatesEnv = linuxEnv,
  waitMs = 90_000
): Promise<void> {
  if (process.platform !== 'linux' && env === linuxEnv)
    throw new Error('maki desktop puts firmware on maki by itself on Linux only, for now')
  for (const f of FIRMWARE_FILES) if (!paths[f]) throw new Error(`no ${f} to put on maki`)
  step('waiting')
  const drive = await waitFor(() => updateDrive(env), waitMs, env)
  if (!drive) throw new Error('maki didn’t show up in update mode (its BAOCHIP drive)')
  step('mounting')
  let at = await mountpoint(drive, env)
  if (!at) {
    // the desktop may be mounting it already: give it a moment, then do it here
    at = await waitFor(() => mountpoint(drive, env), 3_000, env)
    if (!at) {
      await env.udisksctl(['mount', '-b', drive, '--no-user-interaction']).catch(() => '')
      at = await waitFor(() => mountpoint(drive, env), 10_000, env)
    }
  }
  if (!at) throw new Error(`maki’s update drive (${drive}) couldn’t be mounted`)
  for (const f of FIRMWARE_FILES) {
    step('copying', f)
    await copySynced(paths[f], join(at, f))
  }
  step('booting')
  const tty = await waitFor(() => updateConsole(env), 10_000, env)
  if (!tty)
    throw new Error('maki’s new firmware is on it: press a button on maki to start it (no console)')
  // its flag off first, or every start would wait in update mode
  await say(tty, 'bootwait disable', env)
  await env.sleep(500)
  await say(tty, 'boot', env)
}

// ---- maki desktop itself ----

/**
 * Replace the AppImage this runs from with the new one (checked against the store's record),
 * and say where it is: the same file, or for one named for its version, one named for the new
 * version, the old one deleted. The caller restarts maki desktop from there.
 */
export async function replaceAppImage(
  file: ReleaseFile,
  current: { path: string | undefined; version: string; newVersion: string },
  env: Pick<UpdatesEnv, 'fetch'> = linuxEnv,
  progress: (bytes: number) => void = () => {}
): Promise<string> {
  const now = current.path
  if (!now)
    throw new Error(
      'maki desktop isn’t running from an AppImage: get the new one from maki.netslum.io'
    )
  const dir = dirname(now)
  const name = basename(now)
  const next = join(
    dir,
    name.includes(current.version) ? name.replace(current.version, current.newVersion) : name
  )
  const incoming = join(dir, `.${basename(next)}.new`)
  await download(file, incoming, env, progress)
  await chmod(incoming, 0o755)
  await rename(incoming, next)
  if (next !== now) await rm(now, { force: true })
  return next
}
