/**
 * What a format module gives the reader (`index.ts`): how well a document fits it, and its entries.
 */
import type { Csv } from './csv'
import type { Entry, FormatInfo } from './model'
import type { XmlElement } from './xml'

/** A document in an export: a file, or a file in an export's zip, read as what it is. */
export type Doc =
  | { name: string; kind: 'csv'; csv: Csv; encoding: string }
  | { name: string; kind: 'json'; json: unknown }
  | { name: string; kind: 'xml'; xml: XmlElement }

/** Which column holds what, for a CSV whose header doesn't say (or that has none). */
export interface Columns {
  /** whether the first row is a header (not an entry) */
  header: boolean
  /** the columns, by index; -1 for none */
  url: number
  username: number
  password: number
  title: number
  totp: number
}

/** What reading may need from the owner. */
export interface ReadOptions {
  /** the password of an export that has one (Bitwarden's password-protected export) */
  password?: string
  /** for a CSV whose columns aren't known */
  columns?: Columns
  /** how a slow step is coming along, 0 to 1 (a password's key, derived) */
  progress?: (done: number) => void
}

/** A format maki desktop reads. */
export interface Format extends FormatInfo {
  /** what it reads: a CSV file, a JSON one, an XML one */
  reads: Doc['kind']
  /**
   * How sure it is that `doc` is its own: 0 not, 1 it could be (a CSV with the usual columns), 2
   * it's its very own (its exact header, its JSON's shape).
   */
  fits(doc: Doc): number
  /** The entries in `docs`, which fit it; what's worth saying of the file goes in `out`. */
  read(docs: Doc[], options: ReadOptions, out: ReadOut): Promise<Entry[]> | Entry[]
}

/** What reading says besides the entries. */
export interface ReadOut {
  /** what's worth saying about the file as a whole */
  notes: string[]
  /** the manager it's from, when the file says better than the format (the Credential Exchange Format's exporter) */
  source?: string
}

/** An export that can't be read as it is, saying why and what to do instead. */
export class Refused extends Error {}

/** An export that needs its password (`ReadOptions.password`) to be read. */
export class NeedsPassword extends Error {
  constructor(
    /** why it's asked again: the one given was wrong */
    readonly wrong: boolean
  ) {
    super(wrong ? 'that isn’t the export’s password' : 'the export has a password')
  }
}

/** A row's place in a CSV file, for the owner: "line 12". */
export function lineOf(csv: Csv, row: number): string {
  return `line ${csv.lines[row]}`
}
