/**
 * The newest of maki's firmware and of maki desktop, as the maki store signs them into its index
 * (`maki store index --releases`), and how they compare with what's running: maki says which
 * firmware it runs in HELLO (its build, as `git describe` named it), maki desktop knows its own
 * version. Every file of a release is fetched only to be checked against the size and SHA-256
 * the store signed for.
 */

/** A file of a release. */
export interface ReleaseFile {
  name: string
  /** what it runs on, for files that run: `linux-x86_64` */
  platform: string | null
  /** https */
  url: string
  bytes: number
  /** hex */
  sha256: string
}

export interface Release {
  /** as it's tagged: `preview-2026-10-01`, `0.1.2` */
  name: string
  /** the commit it's built from, in full */
  commit: string
  /** YYYY-MM-DD */
  date: string
  /** where it's described, https */
  notes: string | null
  files: ReleaseFile[]
}

export interface Releases {
  firmware: Release | null
  desktop: Release | null
}

/** Where putting firmware on maki is: waiting for its update drive, mounting it, copying, booting. */
export type FirmwareStep = 'waiting' | 'mounting' | 'copying' | 'booting'

/** The firmware's files, in the order they go on maki's update drive. */
export const FIRMWARE_FILES = ['loader.uf2', 'xous.uf2', 'swap.uf2'] as const

/** The biggest file a release may have: maki desktop's AppImage is over a hundred megabytes. */
export const MAX_RELEASE_FILE = 512 * 1024 * 1024

const PLAIN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

function file(v: unknown): ReleaseFile | null {
  if (!v || typeof v !== 'object') return null
  const f = v as Record<string, unknown>
  const { name, platform, url, bytes, sha256 } = f
  if (typeof name !== 'string' || !PLAIN.test(name)) return null
  if (platform !== undefined && (typeof platform !== 'string' || !PLAIN.test(platform))) return null
  if (typeof url !== 'string' || !url.startsWith('https://')) return null
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 1 || (bytes as number) > MAX_RELEASE_FILE)
    return null
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  return {
    name,
    platform: (platform as string | undefined) ?? null,
    url,
    bytes: bytes as number,
    sha256
  }
}

function release(v: unknown): Release | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const { name, commit, date, notes } = r
  if (typeof name !== 'string' || !PLAIN.test(name)) return null
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (notes !== undefined && (typeof notes !== 'string' || !notes.startsWith('https://')))
    return null
  if (!Array.isArray(r.files) || r.files.length === 0) return null
  const files: ReleaseFile[] = []
  for (const f of r.files) {
    const ok = file(f)
    if (!ok) return null
    files.push(ok)
  }
  return { name, commit, date, notes: (notes as string | undefined) ?? null, files }
}

/**
 * The index's `releases`, as signed: each one checked as the tool checks it, and one that isn't
 * right left out rather than trusted. An index from before releases has none.
 */
export function parseReleases(v: unknown): Releases {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  let firmware = release(r.firmware)
  const names = firmware?.files.map((f) => f.name).sort()
  if (firmware && JSON.stringify(names) !== JSON.stringify([...FIRMWARE_FILES].sort()))
    firmware = null
  return { firmware, desktop: release(r.desktop) }
}

// ---- maki's firmware ----

/** A firmware build as `git describe --long --tags` names it: `preview-2026-10-01-3-g1f2e3d4c5`. */
export interface Build {
  /** the release it's built on: `preview-2026-10-01` */
  tag: string
  /** how many commits after it */
  ahead: number
  /** the commit, abbreviated */
  commit: string
}

export function parseBuild(version: string): Build | null {
  const m = /^(.+)-(\d+)-g([0-9a-f]{7,40})$/.exec(version.trim())
  return m ? { tag: m[1], ahead: Number(m[2]), commit: m[3] } : null
}

/** A release's date, from a `preview-YYYY-MM-DD` tag. */
function tagDate(tag: string): string | null {
  return /(\d{4}-\d{2}-\d{2})$/.exec(tag)?.[1] ?? null
}

/**
 * maki's firmware as people read it: `preview 2026-10-01`, or for a build after a release,
 * `preview 2026-09-29 + 46 · 86a1f5ba4`. Firmware from before builds were named said only its
 * link's version (`0.1.0`), which shows as it is.
 */
export function buildLabel(version: string): string {
  const b = parseBuild(version)
  if (!b) return version
  const tag = b.tag.replace(/^preview-/, 'preview ')
  return b.ahead === 0 ? tag : `${tag} + ${b.ahead} · ${b.commit}`
}

/** A release as people read it: `preview 2026-10-01`, `0.1.3`. */
export function releaseLabel(name: string): string {
  return name.replace(/^preview-/, 'preview ')
}

/**
 * How maki's firmware stands against the newest release: `current` (it is that release),
 * `update` (older, or from before builds were named), `ahead` (built after it: a developer's),
 * or `unknown` (a build this can't place, such as one on another tag).
 */
export type FirmwareState = 'current' | 'update' | 'ahead' | 'unknown'

export function firmwareState(version: string, newest: Release): FirmwareState {
  const b = parseBuild(version)
  if (!b) return 'update'
  if (newest.commit.startsWith(b.commit)) return 'current'
  const mine = tagDate(b.tag)
  const theirs = tagDate(newest.name) ?? newest.date
  if (!mine) return 'unknown'
  if (mine < theirs) return 'update'
  return 'ahead'
}

// ---- maki desktop ----

/** Whether version `b` comes after `a`: numbers compared part by part (`0.1.10` after `0.1.9`). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string): number[] =>
    v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0))
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) > (x[i] ?? 0)
  }
  return false
}

/** The platform maki desktop's files are named for: `linux-x86_64`. */
export function platformName(platform: string, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch
  return `${os}-${cpu}`
}
