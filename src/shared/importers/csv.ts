/**
 * CSV as password managers write it (RFC 4180, give or take): fields separated by commas (or
 * semicolons or tabs, from spreadsheets set up for other countries), quoted with `"` when they hold
 * a separator, a quote (doubled) or a line break, rows ended by CRLF or LF.
 */

/** A CSV file, read. */
export interface Csv {
  /** its rows, the header among them, each a list of fields; rows of nothing but empty fields left out */
  rows: string[][]
  /** the line each row starts on, counting from 1, for the owner to find it */
  lines: number[]
  /** what separates the fields */
  separator: ',' | ';' | '\t'
}

/** The most rows a file is read for: far more than anyone's logins, and a bound on the memory a file takes. */
export const MAX_ROWS = 200_000

/**
 * Reads `text` as CSV. `separator` if it's known; otherwise the one the first line has the most of
 * (outside quotes), commas if it has none. A quote in the middle of an unquoted field is kept as
 * it is, as a spreadsheet would; one left open at the end of the file ends there.
 */
export function readCsv(text: string, separator?: Csv['separator']): Csv {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const sep = separator ?? guessSeparator(text)
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  // whether the field began with a quote, and so ends at the quote before a separator
  let inQuotes = false
  let line = 1
  let rowLine = 1
  const endField = (): void => {
    row.push(field)
    field = ''
    quoted = false
  }
  const endRow = (): void => {
    endField()
    if (row.some((f) => f !== '')) {
      if (rows.length >= MAX_ROWS) throw new Error(`more than ${MAX_ROWS} rows`)
      rows.push(row)
      lines.push(rowLine)
    }
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else {
        if (c === '\n') line++
        else if (c === '\r' && text[i + 1] !== '\n') line++
        field += c
      }
      continue
    }
    if (c === '"' && field === '' && !quoted) {
      inQuotes = true
      quoted = true
    } else if (c === sep) {
      endField()
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
      line++
      rowLine = line
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0 || quoted) endRow()
  return { rows, lines, separator: sep }
}

/** The separator the first line has the most of, outside quotes: commas if none. */
function guessSeparator(text: string): Csv['separator'] {
  const seen = { ',': 0, ';': 0, '\t': 0 }
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') inQuotes = !inQuotes
    else if (!inQuotes && (c === '\n' || c === '\r')) break
    else if (!inQuotes && (c === ',' || c === ';' || c === '\t')) seen[c]++
  }
  if (seen['\t'] > seen[','] && seen['\t'] >= seen[';']) return '\t'
  if (seen[';'] > seen[',']) return ';'
  return ','
}

/** A header's name as it's matched: lowercased, with spaces, dashes and underscores gone. */
export function headerKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

/**
 * The columns a header row names, by `headerKey`: the first column of each name. For finding a
 * format's columns whatever order they come in.
 */
export function columnsOf(header: string[]): Map<string, number> {
  const at = new Map<string, number>()
  header.forEach((name, i) => {
    const key = headerKey(name)
    if (!at.has(key)) at.set(key, i)
  })
  return at
}

/** Whether `header` names every one of `names` (by `headerKey`). */
export function hasColumns(header: string[], names: string[]): boolean {
  const at = columnsOf(header)
  return names.every((n) => at.has(headerKey(n)))
}

/**
 * A row's fields by column name: `get('url')` is the row's field in the column the header calls
 * url (or empty, for a column it hasn't or a row that's short).
 */
export function rowReader(header: string[]): (row: string[], name: string) => string {
  const at = columnsOf(header)
  return (row, name) => {
    const i = at.get(headerKey(name))
    return i === undefined ? '' : (row[i] ?? '')
  }
}
