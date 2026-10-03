/**
 * Exports from other password managers, opened: each file (or each file in an export's zip) read
 * as what it is, its format found from what's in it, then its entries read. What can't be told is
 * left to the owner to choose; what can't be read (an encrypted export, a database rather than an
 * export) says why and what to export instead.
 */
import { apple } from './apple'
import { bitwardenCsv, bitwardenJson } from './bitwarden'
import { chromium } from './chromium'
import { readCsv } from './csv'
import { cxf } from './cxf'
import { dashlane } from './dashlane'
import { enpass } from './enpass'
import { firefox } from './firefox'
import {
  NeedsPassword,
  Refused,
  type Columns,
  type Doc,
  type Format,
  type ReadOptions,
  type ReadOut
} from './format'
import { generic, guessColumns } from './generic'
import { keepassXml, keepassxcCsv } from './keepass'
import { keeperCsv, keeperJson } from './keeper'
import { lastpass } from './lastpass'
import type { ExportFile, FormatId, FormatInfo, Parsed } from './model'
import { nordpass } from './nordpass'
import { onePasswordCsv, onePux } from './onepassword'
import { protonCsv, protonJson } from './proton'
import { decodeText } from './text'
import { readXml, XmlError } from './xml'
import { isZip, Zip, ZipError } from './zip'

export { memoryFile, type ExportFile, type FormatId, type FormatInfo, type Parsed } from './model'
export type { Columns } from './format'

/** Every format maki desktop reads, the generic CSV last. */
export const FORMATS: Format[] = [
  bitwardenJson,
  bitwardenCsv,
  protonJson,
  protonCsv,
  lastpass,
  onePux,
  onePasswordCsv,
  keepassxcCsv,
  keepassXml,
  dashlane,
  chromium,
  firefox,
  apple,
  nordpass,
  enpass,
  keeperJson,
  keeperCsv,
  cxf,
  generic
]

/** The biggest file read whole: far more than any export's text, and a bound on memory. */
export const MAX_FILE = 32 * 1024 * 1024

/** A format's description, for the owner. */
export function formatInfo(id: FormatId): FormatInfo {
  const f = FORMATS.find((x) => x.id === id) ?? generic
  return { id: f.id, manager: f.manager, label: f.label }
}

/** What opening an export came to. */
export type Opened =
  /** read: its entries, as `format` (which the file said for sure, or which was the likeliest) */
  | {
      state: 'read'
      format: FormatInfo
      /** whether what's in the file said which it is (rather than its columns hinting) */
      sure: boolean
      /** whether the owner chose the format */
      chosen: boolean
      parsed: Parsed
      /** the formats a file like it could be, for the owner to choose another */
      others: FormatInfo[]
      /** for a CSV read by columns: its columns, and which were used */
      csv?: { columns: CsvColumn[]; used: Columns }
    }
  /** the export has a password, which reading needs (or the one given was wrong) */
  | { state: 'password'; format: FormatInfo; wrong: boolean }
  /** what it's from can't be told: the owner chooses */
  | { state: 'choose'; why: string; formats: FormatInfo[] }
  /** it can't be read, saying why and what to do */
  | { state: 'refused'; why: string }

/** A CSV column, for the owner to choose columns by: its name, and what it looks like (never a password). */
export interface CsvColumn {
  index: number
  /** its header's name, or "column 3" */
  name: string
  /** what its values look like, when that's safe to show: "web addresses (github.com…)" */
  looks: string | null
}

/** What opening an export may be told. */
export interface OpenOptions extends ReadOptions {
  /** the format the owner chose, over the one found */
  format?: FormatId
}

/** The files in a zip worth reading as documents: text that an export's data is in. */
const IN_ZIP = /\.(json|csv|xml|data|pgp|gpg|asc|1pif)$/i
/** Where exports keep their attachments (1PUX's and Proton Pass's `files/`, Bitwarden's `attachments/`), not their data. */
const ATTACHMENTS = /(^|\/)(files|attachments)\//i

/** Bytes that are KeePass's database itself (KDBX). */
const KDBX = [0x03, 0xd9, 0xa2, 0x9a]

/** One file (or a zip's file) as a document; a Refused for one that can't be read. */
function toDoc(name: string, bytes: Uint8Array): Doc | Refused | null {
  if (KDBX.every((b, i) => bytes[i] === b))
    return new Refused(
      `${name} is a KeePass database, not an export. In KeePassXC: Database › Export › CSV File; in KeePass: File › Export › KeePass XML (2.x).`
    )
  // a binary OpenPGP message: a session key packet first
  if (
    bytes.length > 0 &&
    [0x84, 0x85, 0x8c, 0xc1, 0xc3].includes(bytes[0]) &&
    !/\.(csv|json|xml)$/i.test(name)
  )
    return new Refused(pgpWhy(name))
  const { text, encoding } = decodeText(bytes)
  // a picture, a database, a program: not text at all
  const controls =
    text.slice(0, 4096).match(/[\u0000-\u0008\u000e-\u001a\u001c-\u001f]/g)?.length ?? 0
  if (controls > 8)
    return new Refused(
      `${name} isn’t an export maki desktop reads: it isn’t text (CSV, JSON or XML), nor a zip of it.`
    )
  const start = text.trimStart()
  if (start.startsWith('-----BEGIN PGP')) return new Refused(pgpWhy(name))
  if (/^-+ Dashlane Secured Export -+/.test(start))
    return new Refused(
      `${name} is Dashlane’s encrypted export (DASH), which only Dashlane opens. In Dashlane: Settings › Export data, as CSV.`
    )
  if (start.startsWith('{') || start.startsWith('[')) {
    try {
      return { name, kind: 'json', json: JSON.parse(start) as unknown }
    } catch {
      return new Refused(
        `${name} looks like JSON, but it can’t be read as JSON: it may be cut short.`
      )
    }
  }
  if (start.startsWith('<')) {
    try {
      return { name, kind: 'xml', xml: readXml(start) }
    } catch (e) {
      return new Refused(
        `${name} looks like XML, but it can’t be read: ${e instanceof XmlError ? e.message : 'it isn’t well-formed'}.`
      )
    }
  }
  if (start.startsWith('***') && /\*{3}[0-9a-f-]{36}\*{3}/.test(start.slice(0, 200)))
    return new Refused(
      `${name} is in 1Password’s older 1PIF format. In 1Password 8: File › Export, as 1PUX (or CSV).`
    )
  if (start === '') return null
  return { name, kind: 'csv', csv: readCsv(text), encoding }
}

/** Why an encrypted export can't be read, and what to do. */
function pgpWhy(name: string): string {
  return `${name} is encrypted with PGP (Proton Pass’s encrypted export, say). maki desktop reads exports that aren’t: export again without encryption, import it, then move the file to the trash.`
}

/**
 * The documents in `files`: each file, or the files in a zip (only the ones an export's data is
 * in: JSON, CSV, XML). Refusals for those that can't be read.
 */
async function documents(
  files: ExportFile[]
): Promise<{ docs: Doc[]; refused: Refused[]; inZip: Set<Doc> }> {
  const docs: Doc[] = []
  const refused: Refused[] = []
  const inZip = new Set<Doc>()
  for (const file of files) {
    const head = await file.read(0, 8)
    if (isZip(head)) {
      let zip: Zip
      try {
        zip = await Zip.open(file)
      } catch (e) {
        refused.push(
          new Refused(`${file.name} is a zip that can’t be read: ${(e as Error).message}.`)
        )
        continue
      }
      const wanted = zip.entries.filter(
        (e) => !e.name.endsWith('/') && IN_ZIP.test(e.name) && !ATTACHMENTS.test(e.name)
      )
      if (wanted.length > 0 && wanted.every((e) => e.encrypted)) {
        refused.push(
          new Refused(
            `${file.name} is a zip with a password. Export again without one (or unzip it first).`
          )
        )
        continue
      }
      for (const e of wanted) {
        try {
          const doc = toDoc(e.name.split('/').pop() ?? e.name, await zip.read(e))
          if (doc instanceof Refused) refused.push(doc)
          else if (doc) {
            docs.push(doc)
            inZip.add(doc)
          }
        } catch (err) {
          refused.push(
            new Refused(err instanceof ZipError ? `${file.name}: ${err.message}.` : String(err))
          )
        }
      }
      continue
    }
    if (file.size > MAX_FILE) {
      refused.push(
        new Refused(
          `${file.name} is bigger than an export maki desktop reads (${MAX_FILE >> 20} MiB).`
        )
      )
      continue
    }
    const doc = toDoc(file.name, await file.read(0, file.size))
    if (doc instanceof Refused) refused.push(doc)
    else if (doc) docs.push(doc)
  }
  return { docs, refused, inZip }
}

/** What a CSV's columns look like, for choosing them: names, and samples only of what's safe to show. */
export function csvColumns(rows: string[][], header: boolean): CsvColumn[] {
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length))
  const body = rows.slice(header ? 1 : 0, 51)
  return Array.from({ length: width }, (_, i) => {
    const values = body.map((r) => (r[i] ?? '').trim()).filter((v) => v !== '')
    const share = (re: RegExp): number =>
      values.filter((v) => re.test(v)).length / Math.max(1, values.length)
    let looks: string | null = null
    if (values.length === 0) looks = 'empty'
    else if (share(/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?$/i) >= 0.6) {
      const host = values[0].replace(/^https?:\/\//i, '').split(/[/?#:]/)[0]
      looks = `web addresses (${host}…)`
    } else if (share(/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i) >= 0.6) looks = 'email addresses'
    else if (share(/^otpauth:\/\//i) >= 0.6) looks = 'codes (otpauth://)'
    return {
      index: i,
      name: header ? rows[0][i]?.trim() || `column ${i + 1}` : `column ${i + 1}`,
      looks
    }
  })
}

/**
 * Opens `files`, an export from another password manager (one file, or several of one manager's,
 * or a zip): its format found from what's in it (or the one `options.format` names), then its
 * entries read.
 */
export async function openExport(files: ExportFile[], options: OpenOptions = {}): Promise<Opened> {
  if (files.length === 0) return { state: 'refused', why: 'No file was chosen.' }
  const { docs: all, refused, inZip } = await documents(files)
  if (all.length === 0) {
    return {
      state: 'refused',
      why: refused.map((r) => r.message).join(' ') || 'There’s nothing in it to read.'
    }
  }

  // each document's likeliest format; a zip's documents no format fits are left alone (attachments)
  const fitted = all.map((doc) => {
    let best: Format | null = null
    let score = 0
    for (const f of FORMATS) {
      if (f.reads !== doc.kind) continue
      const s = f.fits(doc)
      if (s > score) ((best = f), (score = s))
    }
    return { doc, best, score }
  })
  const kept = fitted.filter(
    (x) => x.score > 0 || !inZip.has(x.doc) || options.format !== undefined
  )
  const docs = (kept.length > 0 ? kept : fitted).map((x) => x.doc)
  const kinds = [...new Set(docs.map((d) => d.kind))]
  const others = FORMATS.filter((f) => kinds.includes(f.reads)).map((f) => formatInfo(f.id))

  let format: Format
  let sure = true
  if (options.format !== undefined) {
    format = FORMATS.find((f) => f.id === options.format) ?? generic
    sure = false
    if (!kinds.includes(format.reads))
      return {
        state: 'refused',
        why: `${files.map((f) => f.name).join(', ')} isn’t ${format.reads.toUpperCase()}, as ${format.label} is.`
      }
  } else {
    const found = (kept.length > 0 ? kept : fitted).filter((x) => x.score > 0)
    const managers = [...new Set(found.map((x) => x.best!.manager))]
    if (managers.length > 1)
      return {
        state: 'refused',
        why: `These files are from different managers (${managers.join(' and ')}): import them one at a time.`
      }
    // a CSV of no manager's, whose columns are named the usual way: read by those names
    const byNames =
      found.length === 0 && docs.every((d) => d.kind === 'csv' && guessColumns(d.csv).header)
    if (byNames) {
      format = generic
      sure = false
    } else if (found.length === 0 || found.length < docs.length) {
      return {
        state: 'choose',
        why:
          kinds.length === 1 && kinds[0] === 'csv'
            ? 'Which manager this CSV is from can’t be told from its columns.'
            : 'Which manager this is from can’t be told from what’s in it.',
        formats: others
      }
    } else {
      // the format that fits best; a CSV with only the usual columns is a guess
      found.sort((a, b) => b.score - a.score)
      format = found[0].best!
      sure = found.every((x) => x.score >= 2)
    }
  }

  const used = docs.filter((d) => d.kind === format.reads)
  const out: ReadOut = { notes: [] }
  for (const d of used)
    if (d.kind === 'csv' && d.encoding !== 'UTF-8' && d.encoding !== 'UTF-16')
      out.notes.push(
        `${d.name} isn’t UTF-8: it’s read as ${d.encoding}, as files saved by older software on Windows are.`
      )
  for (const r of refused) out.notes.push(r.message)
  let entries
  try {
    entries = await format.read(used, options, out)
  } catch (e) {
    if (e instanceof NeedsPassword)
      return { state: 'password', format: formatInfo(format.id), wrong: e.wrong }
    if (e instanceof Refused) return { state: 'refused', why: e.message }
    throw e
  }
  const opened: Opened = {
    state: 'read',
    format: formatInfo(format.id),
    sure,
    chosen: options.format !== undefined,
    parsed: { format: format.id, source: out.source ?? format.manager, entries, notes: out.notes },
    others
  }
  if (format.id === 'generic-csv' && used[0]?.kind === 'csv') {
    const columns = options.columns ?? guessColumns(used[0].csv)
    opened.csv = { columns: csvColumns(used[0].csv.rows, columns.header), used: columns }
  }
  return opened
}
