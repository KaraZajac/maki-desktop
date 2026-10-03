/**
 * Zip files, read: the exports that come as one (Proton Pass's, 1Password's 1PUX, Dashlane's CSVs).
 * The central directory is read from the end of the file, then only the entries asked for, so a
 * big export (one with attachments) isn't read whole. Stored and deflated entries (all exports'
 * are one or the other); deflate through the platform's own DecompressionStream; each entry's
 * CRC-32 checked. Zip64 too. No Node or DOM imports.
 */
import { crc32 } from '../protocol'
import type { ExportFile } from './model'

/** An entry in a zip. */
export interface ZipEntry {
  /** its path in the zip, with `/` between folders */
  name: string
  /** 0 stored, 8 deflated (others aren't read) */
  method: number
  /** its size in the zip, and when it's taken out */
  compressedSize: number
  size: number
  crc: number
  /** where its local header is */
  offset: number
  /** encrypted with the zip's own password */
  encrypted: boolean
}

/** The most entries a zip may have: an export's few, or its attachments. */
export const MAX_ENTRIES = 100_000
/** The biggest entry that's taken out: far more than an export's data, and a bound on memory. */
export const MAX_ENTRY = 128 * 1024 * 1024

/** Whether `head` (a file's first bytes) starts a zip. */
export function isZip(head: Uint8Array): boolean {
  return (
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 3 || head[2] === 5) &&
    head[3] === head[2] + 1
  )
}

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8)
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const u64 = (b: Uint8Array, at: number): number => u32(b, at) + u32(b, at + 4) * 2 ** 32

/** A zip that can't be read, saying why in the owner's terms. */
export class ZipError extends Error {}

/** A zip's entries, read from its central directory. */
export class Zip {
  private constructor(
    private file: ExportFile,
    readonly entries: ZipEntry[]
  ) {}

  /** Reads the central directory of `file`, which must be a zip. */
  static async open(file: ExportFile): Promise<Zip> {
    const tail = Math.min(file.size, 22 + 0xffff + 20)
    const end = await file.read(file.size - tail, tail)
    // the end of central directory record, found from the end (a comment may follow it)
    let eocd = -1
    for (let i = end.length - 22; i >= 0; i--) {
      if (u32(end, i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new ZipError('it isn’t a whole zip file (its end is missing)')
    let count = u16(end, eocd + 10)
    let dirSize = u32(end, eocd + 12)
    let dirAt = u32(end, eocd + 16)
    if (count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff) {
      // zip64: its own end record, which a locator just before this one points to
      if (eocd < 20 || u32(end, eocd - 20) !== 0x07064b50)
        throw new ZipError('it isn’t a whole zip file (its zip64 record is missing)')
      const at = u64(end, eocd - 12)
      const rec = await file.read(at, 56)
      if (rec.length < 56 || u32(rec, 0) !== 0x06064b50)
        throw new ZipError('it isn’t a whole zip file (its zip64 record is missing)')
      count = u64(rec, 32)
      dirSize = u64(rec, 40)
      dirAt = u64(rec, 48)
    }
    if (count > MAX_ENTRIES) throw new ZipError(`it has more than ${MAX_ENTRIES} files in it`)
    if (dirAt + dirSize > file.size) throw new ZipError('it isn’t a whole zip file')
    const dir = await file.read(dirAt, dirSize)
    const entries: ZipEntry[] = []
    let at = 0
    for (let n = 0; n < count; n++) {
      if (at + 46 > dir.length || u32(dir, at) !== 0x02014b50)
        throw new ZipError('its list of files is damaged')
      const flags = u16(dir, at + 8)
      const nameLength = u16(dir, at + 28)
      const extraLength = u16(dir, at + 30)
      const commentLength = u16(dir, at + 32)
      const rawName = dir.subarray(at + 46, at + 46 + nameLength)
      // names are UTF-8 when flag 11 says so; the ones looked for are ASCII either way
      const name =
        flags & 0x800
          ? new TextDecoder().decode(rawName)
          : String.fromCharCode(...rawName.subarray(0, 1024))
      let compressedSize = u32(dir, at + 20)
      let size = u32(dir, at + 24)
      let offset = u32(dir, at + 42)
      // zip64's sizes and offset, in its extra field, for the ones that didn't fit
      const extra = dir.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
      for (let e = 0; e + 4 <= extra.length;) {
        const id = u16(extra, e)
        const length = u16(extra, e + 2)
        if (id === 0x0001) {
          let f = e + 4
          if (size === 0xffffffff && f + 8 <= e + 4 + length) ((size = u64(extra, f)), (f += 8))
          if (compressedSize === 0xffffffff && f + 8 <= e + 4 + length)
            ((compressedSize = u64(extra, f)), (f += 8))
          if (offset === 0xffffffff && f + 8 <= e + 4 + length) offset = u64(extra, f)
        }
        e += 4 + length
      }
      const method = u16(dir, at + 10)
      entries.push({
        name: name.replace(/\\/g, '/'),
        method,
        compressedSize,
        size,
        crc: u32(dir, at + 16),
        offset,
        // flag 0 is the zip's own encryption; method 99, WinZip's AES
        encrypted: (flags & 1) !== 0 || method === 99
      })
      at += 46 + nameLength + extraLength + commentLength
    }
    return new Zip(file, entries)
  }

  /** The entry at `name` (a path in the zip), or the first whose name ends with it after a `/`. */
  find(name: string): ZipEntry | undefined {
    const lower = name.toLowerCase()
    return (
      this.entries.find((e) => e.name.toLowerCase() === lower) ??
      this.entries.find((e) => e.name.toLowerCase().endsWith(`/${lower}`))
    )
  }

  /** An entry's bytes, taken out and checked against its CRC-32. */
  async read(entry: ZipEntry): Promise<Uint8Array> {
    if (entry.encrypted)
      throw new ZipError(`${entry.name} is encrypted in the zip: export it without a password`)
    if (entry.size > MAX_ENTRY)
      throw new ZipError(`${entry.name} is bigger than maki desktop reads (${MAX_ENTRY >> 20} MiB)`)
    const local = await this.file.read(entry.offset, 30)
    if (local.length < 30 || u32(local, 0) !== 0x04034b50)
      throw new ZipError(`${entry.name} is damaged in the zip`)
    const start = entry.offset + 30 + u16(local, 26) + u16(local, 28)
    const raw = await this.file.read(start, entry.compressedSize)
    if (raw.length < entry.compressedSize) throw new ZipError(`${entry.name} is cut short`)
    let data: Uint8Array
    if (entry.method === 0) data = raw
    else if (entry.method === 8) data = await inflate(raw, entry.size, entry.name)
    else
      throw new ZipError(
        `${entry.name} is compressed in a way maki desktop doesn’t read (method ${entry.method})`
      )
    if (data.length !== entry.size || crc32(data) !== entry.crc)
      throw new ZipError(`${entry.name} is damaged in the zip (its checksum is wrong)`)
    return data
  }
}

/** Raw deflate, taken out to at most `size` bytes (what the zip says it is). */
async function inflate(raw: Uint8Array, size: number, name: string): Promise<Uint8Array> {
  const out = new Uint8Array(size)
  let got = 0
  const reader = new Blob([raw as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (got + value.length > size) {
        await reader.cancel().catch(() => {})
        throw new ZipError(`${name} is damaged in the zip (it’s bigger than it says)`)
      }
      out.set(value, got)
      got += value.length
    }
  } catch (e) {
    if (e instanceof ZipError) throw e
    throw new ZipError(`${name} is damaged in the zip`)
  }
  return got === size ? out : out.subarray(0, got)
}
