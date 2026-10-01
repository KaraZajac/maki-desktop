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
import { createHash, randomBytes } from 'node:crypto'
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
/** maki itself, running. */
const MAKI_USB = { vendor: '1d50', product: '6198' }
/** How long a download may go without a byte before it's given up. */
const IDLE_MS = 60_000
const DRIVE_LABEL = 'BAOCHIP'

// ---- downloads ----

/**
 * Fetch `file` to `dest`, checking it against the size and SHA-256 the store signed for it: a
 * file that's any bigger stops as it comes, and the whole of it is checked again on disk before
 * it's put at `dest`. It comes into a file of its own, so two downloads of one file can't mix.
 * https only, redirects included (GitHub's releases redirect to its file servers). Given up
 * after a minute without a byte, however long the whole takes.
 */
export async function download(
  file: ReleaseFile,
  dest: string,
  env: Pick<UpdatesEnv, 'fetch'> = linuxEnv,
  progress: (bytes: number) => void = () => {}
): Promise<void> {
  const part = `${dest}.${randomBytes(6).toString('hex')}.part`
  await mkdir(dirname(dest), { recursive: true })
  const stalled = new AbortController()
  let idle = setTimeout(() => stalled.abort(), IDLE_MS)
  const awake = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => stalled.abort(), IDLE_MS)
  }
  try {
    const r = await env.fetch(file.url, { redirect: 'follow', signal: stalled.signal })
    if (!r.ok) throw new Error(`${file.name}: the download answered ${r.status}`)
    if (r.url && !r.url.startsWith('https://')) throw new Error(`${file.name}: not over https`)
    if (!r.body) throw new Error(`${file.name}: nothing came`)
    const out = await open(part, 'wx')
    let got = 0
    try {
      const reader = r.body.getReader()
      for (;;) {
        awake()
        const { done, value } = await reader.read()
        if (done) break
        got += value.length
        if (got > file.bytes) {
          await reader.cancel().catch(() => {})
          throw new Error(`${file.name}: bigger than the store says it is`)
        }
        await out.writeFile(value)
        progress(got)
      }
      await out.sync()
    } finally {
      await out.close().catch(() => {})
    }
    // what's on disk, all of it: a write cut short shows here
    if (!(await verified(file, part)))
      throw new Error(`${file.name} isn’t what the maki store signed for: not taken`)
    await rename(part, dest)
  } catch (e) {
    await rm(part, { force: true })
    if (stalled.signal.aborted) throw new Error(`${file.name}: the download stalled`)
    throw e
  } finally {
    clearTimeout(idle)
  }
}

/** Whether the file at `path` is the one the store signed for. */
export async function verified(file: ReleaseFile, path: string): Promise<boolean> {
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
    if (!(await verified(f, path)))
      await download(f, path, env, (b) => progress(f.name, b, f.bytes))
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

async function isUsb(
  dir: string | null,
  id: { vendor: string; product: string }
): Promise<boolean> {
  if (!dir) return false
  const [v, p] = await Promise.all(
    ['idVendor', 'idProduct'].map((f) =>
      readFile(join(dir, f), 'utf8').then(
        (s) => s.trim(),
        () => ''
      )
    )
  )
  return v === id.vendor && p === id.product
}

/** Every USB device with this ID: its folder in /sys, which is the port it's plugged into. */
async function usbDevices(
  env: UpdatesEnv,
  id: { vendor: string; product: string }
): Promise<string[]> {
  const bus = join(env.sys, 'bus', 'usb', 'devices')
  const names = await readdir(bus).catch(() => [] as string[])
  const found: string[] = []
  for (const n of names.filter((n) => !n.includes(':')).sort()) {
    const dir = await realpath(join(bus, n)).catch(() => null)
    if (dir && (await isUsb(dir, id))) found.push(dir)
  }
  return found
}

/**
 * The port maki is plugged into, running: noted before it restarts into update mode, which it
 * shows on the same port. None if there's no maki, or more than one.
 */
export async function makiPort(env: UpdatesEnv = linuxEnv): Promise<string | null> {
  const ports = await usbDevices(env, MAKI_USB)
  return ports.length === 1 ? ports[0] : null
}

/**
 * The boot1 to update: the one on maki's port, if that's known; if not, the only one there is.
 * Every boot1 has the same ID (another badge, a Dabao board), so with two and no port, none.
 */
async function updateDevice(env: UpdatesEnv, port: string | null): Promise<string | null> {
  const all = await usbDevices(env, UPDATE_USB)
  if (port) return all.includes(port) ? port : null
  return all.length === 1 ? all[0] : null
}

/** maki's update drive, if it's there: its block device (/dev/sdb). */
export async function updateDrive(
  env: UpdatesEnv = linuxEnv,
  port: string | null = null
): Promise<string | null> {
  const device = await updateDevice(env, port)
  if (!device) return null
  const byLabel = join(env.dev, 'disk', 'by-label', DRIVE_LABEL)
  const target = await readlink(byLabel).catch(() => null)
  if (!target) return null
  const disk = resolve(dirname(byLabel), target)
  // the label alone could be anyone's: it must be that boot1's
  return (await usbDevice(env, 'block', basename(disk))) === device ? disk : null
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

/** maki's update console: the tty of the same boot1 as the drive. */
export async function updateConsole(
  env: UpdatesEnv = linuxEnv,
  port: string | null = null
): Promise<string | null> {
  const device = await updateDevice(env, port)
  if (!device) return null
  const ttys = await readdir(join(env.sys, 'class', 'tty')).catch(() => [] as string[])
  for (const t of ttys.filter((n) => /^ttyACM\d+$/.test(n)).sort()) {
    if ((await usbDevice(env, 'tty', t)) === device) return join(env.dev, t)
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

/** Write a file whole, synced: on maki's drive, synced means written into its flash. */
async function writeSynced(to: string, data: Uint8Array): Promise<void> {
  const out = await open(to, 'w')
  try {
    await out.writeFile(data)
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
 * Put new firmware on maki in its update mode (`files`: loader.uf2, xous.uf2 and swap.uf2, where
 * they are and what the store signed for each), and start it. Waits up to `waitMs` for maki to
 * show up there, on `port` (where maki was plugged in when it restarted for this) if known.
 */
export async function installFirmware(
  files: { path: string; file: ReleaseFile }[],
  step: (s: FirmwareStep, detail?: string) => void,
  env: UpdatesEnv = linuxEnv,
  waitMs = 90_000,
  port: string | null = null
): Promise<void> {
  if (process.platform !== 'linux' && env === linuxEnv)
    throw new Error('maki desktop puts firmware on maki by itself on Linux only, for now')
  // each read and checked again now, just before it goes on maki
  const data: Record<string, Uint8Array> = {}
  for (const name of FIRMWARE_FILES) {
    const f = files.find((x) => x.file.name === name)
    if (!f) throw new Error(`no ${name} to put on maki`)
    const bytes = await readFile(f.path).catch(() => null)
    if (
      !bytes ||
      bytes.length !== f.file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== f.file.sha256
    )
      throw new Error(`${name} isn’t what the maki store signed for any more: update again`)
    data[name] = bytes
  }
  step('waiting')
  const drive = await waitFor(() => updateDrive(env, port), waitMs, env)
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
    await writeSynced(join(at, f), data[f])
  }
  step('booting')
  const tty = await waitFor(() => updateConsole(env, port), 10_000, env)
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
