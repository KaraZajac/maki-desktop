import { useEffect, useMemo, useRef, useState } from 'react'
import type { VaultStatus } from '@shared/client'
import {
  encodeImport,
  importSays,
  type ImportRecord,
  list,
  MAX_IMPORT,
  MAX_RECORDS,
  splitImport,
  type ImportResult
} from '@shared/import'
import {
  memoryFile,
  openExport,
  type Columns,
  type ExportFile,
  type FormatId,
  type Opened
} from '@shared/importers'
import { prepare, wipe, wipeParsed, type Prepared } from '@shared/importers/prepare'
import type { Link } from '@shared/link'
import type { Page } from './pages'
import { Badge, Button, Card, Field, Glyph, Label, PageHeader, Toggle } from './ui'

/** An export the owner chose, as main handed it over. */
interface Chosen {
  id: number
  name: string
  size: number
  data: Uint8Array | null
}

/** How many rows the preview's table shows. */
const ROWS = 1000

/** "1 login", "3 logins". */
const count = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The first letter capitalized, for a reason that starts a sentence (maki's name stays as it is). */
const upper = (s: string): string =>
  s && !s.startsWith('maki') ? s[0].toUpperCase() + s.slice(1) : s

/**
 * Logins & passkeys: what maki's vault holds, how its logins reach sites, and logins, codes and
 * passkeys imported from another password manager.
 */
export function LoginsPage({
  link,
  go
}: {
  link: Link
  go: (page: Page) => void
}): React.JSX.Element {
  const linked = link.state.linked
  // undefined: not asked yet; null: firmware from before imports
  const [vault, setVault] = useState<VaultStatus | null | undefined>(undefined)
  const refresh = (): void => {
    if (!link.state.linked) return setVault(undefined)
    link
      .vaultStatus()
      .then(setVault)
      .catch(() => setVault(undefined))
  }
  // asked again when the link has news: a login kept, an import, maki unlocked
  useEffect(refresh, [link, linked, link.notes])

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="on maki"
        title="Logins & passkeys"
        lede="What maki’s vault holds, how its logins reach the sites you sign in to, and logins, codes and passkeys brought over from another password manager."
      />
      <Holds linked={linked} vault={vault} go={go} />
      <Card>
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
            <Glyph name="globe" className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <Label>at sites</Label>
            <p className="mt-2 text-sm leading-relaxed text-subtext1">
              The maki extension fills a login when you click into a site’s login field: maki shows
              the site and asks you first, and the password goes to that site’s page alone. Codes
              fill the same way. Passkeys need nothing here: the site asks maki as it would a
              security key, and maki asks you.
            </p>
            <div className="mt-3">
              <Button small kind="ghost" glyph="globe" onClick={() => go('browsers')}>
                Browsers
              </Button>
            </div>
          </div>
        </div>
      </Card>
      <Import link={link} vault={vault} go={go} refresh={refresh} />
    </div>
  )
}

/** What maki's vault holds: its counts, or why there are none to show. */
function Holds({
  linked,
  vault,
  go
}: {
  linked: boolean
  vault: VaultStatus | null | undefined
  go: (page: Page) => void
}): React.JSX.Element | null {
  if (linked && vault === null)
    return (
      <Card>
        <Label>in the vault</Label>
        <p className="mt-3 text-sm text-subtext1">
          This maki’s firmware doesn’t say what its vault holds, nor take imports. Newer firmware
          does both.
        </p>
        <div className="mt-3">
          <Button small kind="ghost" glyph="info" onClick={() => go('about')}>
            Updates, in About
          </Button>
        </div>
      </Card>
    )
  const tile = (name: string, n: number, under: string): React.JSX.Element => (
    <div className="rounded-xl border border-surface1 bg-crust/50 px-4 py-3">
      <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
        {name}
      </div>
      <div className="mt-1.5 font-mono text-[1.7rem] leading-none font-bold tracking-[-0.03em] text-fg">
        {n.toLocaleString()}
      </div>
      <div className="mt-1.5 text-xs text-overlay1">{under}</div>
    </div>
  )
  return (
    <Card>
      <Label>in the vault</Label>
      {!linked ? (
        <p className="mt-3 text-sm text-subtext1">Plug maki in to see what it holds.</p>
      ) : vault == null ? (
        <p className="mt-3 text-sm text-subtext0">Asking maki…</p>
      ) : vault.status === 'locked' ? (
        <p className="mt-3 text-sm text-subtext1">
          maki is locked. Once its PIN is in, this shows what it holds.
        </p>
      ) : vault.status === 'no phrase' ? (
        <p className="mt-3 text-sm text-subtext1">
          maki has no recovery phrase yet, so its vault holds nothing. Set one up on maki first.
        </p>
      ) : vault.status !== 'approved' ? (
        <p className="mt-3 text-sm text-subtext1">
          maki couldn’t read its vault just then. This asks again when maki has news.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-3">
          {tile('logins', vault.logins, 'a site, a username, a password')}
          {tile('codes', vault.codes, 'two-step codes (TOTP)')}
          {tile(
            'passkeys',
            vault.passkeys,
            vault.imported === 0
              ? 'made on maki'
              : vault.imported >= vault.passkeys
                ? vault.passkeys === 1
                  ? 'imported'
                  : 'all imported'
                : `${vault.imported.toLocaleString()} imported, ${(vault.passkeys - vault.imported).toLocaleString()} made on maki`
          )}
        </div>
      )}
    </Card>
  )
}

/** The most main hands over at once, of a big export read a range at a time. */
const PIECE = 16 * 1024 * 1024

/** A chosen export as the reader takes it: whole, or read a range at a time through main. */
function asFile(c: Chosen): ExportFile {
  if (c.data) return memoryFile(c.name, c.data)
  return {
    name: c.name,
    size: c.size,
    read: async (offset, length) => {
      const out = new Uint8Array(Math.max(0, Math.min(length, c.size - offset)))
      for (let at = 0; at < out.length;) {
        const piece = await window.maki.imports.read(
          c.id,
          offset + at,
          Math.min(PIECE, out.length - at)
        )
        if (piece.length === 0) return out.subarray(0, at)
        out.set(piece, at)
        at += piece.length
      }
      return out
    }
  }
}

/** An import from another manager: a file chosen, read, shown, sent; then what came of it. */
function Import({
  link,
  vault,
  go,
  refresh
}: {
  link: Link
  vault: VaultStatus | null | undefined
  go: (page: Page) => void
  refresh: () => void
}): React.JSX.Element {
  const linked = link.state.linked
  const [files, setFiles] = useState<Chosen[] | null>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [format, setFormat] = useState<FormatId | undefined>(undefined)
  const [columns, setColumns] = useState<Columns | undefined>(undefined)
  const [password, setPassword] = useState('')
  const [reading, setReading] = useState<number | null>(null)
  const [sending, setSending] = useState<{
    sent: number
    total: number
    part: number
    parts: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{
    source: string
    results: ImportResult[]
    error: string | null
    files: { id: number; name: string }[]
  } | null>(null)
  const [trashed, setTrashed] = useState<{ ok: boolean; text: string } | null>(null)
  // what's held, for dropping it however the page is left
  const held = useRef<{
    files: Chosen[] | null
    opened: Opened | null
    prepared: Prepared | null
  }>({ files: null, opened: null, prepared: null })

  const prepared = useMemo(
    () => (opened?.state === 'read' ? prepare(opened.parsed) : null),
    [opened]
  )
  held.current.prepared = prepared
  held.current.opened = opened
  held.current.files = files
  // the entries the owner unticked, by their row: they stay out
  const [skip, setSkip] = useState<Set<number>>(new Set())
  useEffect(() => setSkip(new Set()), [prepared])
  const chosen = useMemo(
    () =>
      prepared
        ? prepared.rows.flatMap((r, i) =>
            skip.has(i) ? [] : r.records.map((n) => prepared.records[n])
          )
        : [],
    [prepared, skip]
  )

  /** Lets go of everything read: the files' bytes wiped, the records' keys and secrets too. */
  const drop = (forget: boolean): void => {
    const { files: f, opened: o, prepared: p } = held.current
    for (const c of f ?? []) c.data?.fill(0)
    if (p) wipe(p)
    if (o?.state === 'read') wipeParsed(o.parsed)
    if (forget && f) void window.maki.imports.forget(f.map((c) => c.id))
    held.current = { files: null, opened: null, prepared: null }
    setFiles(null)
    setOpened(null)
    setFormat(undefined)
    setColumns(undefined)
    setPassword('')
  }
  // leaving the page abandons an import under way
  useEffect(() => () => drop(true), [])

  const read = async (
    chosen: Chosen[],
    options: { format?: FormatId; columns?: Columns; password?: string }
  ): Promise<void> => {
    setReading(0)
    setError(null)
    try {
      const got = await openExport(chosen.map(asFile), {
        ...options,
        progress: (n) => setReading(n)
      })
      // what was read before (as another format, say) goes
      const { opened: before, prepared: was } = held.current
      if (was) wipe(was)
      if (before?.state === 'read') wipeParsed(before.parsed)
      setOpened(got)
      if (got.state === 'read') setPassword('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setReading(null)
    }
  }

  const choose = async (): Promise<void> => {
    setError(null)
    setDone(null)
    setTrashed(null)
    let chosen: Chosen[] | null
    try {
      chosen = await window.maki.imports.open()
    } catch (e) {
      setError((e as Error).message)
      return
    }
    if (!chosen) return
    drop(true)
    setFiles(chosen)
    held.current.files = chosen
    await read(chosen, {})
  }

  const again = (options: { format?: FormatId; columns?: Columns; password?: string }): void => {
    if (!files) return
    const next = {
      format: 'format' in options ? options.format : format,
      columns: 'columns' in options ? options.columns : columns,
      password: options.password
    }
    setFormat(next.format)
    setColumns(next.columns)
    void read(files, next)
  }

  const send = async (records: ImportRecord[]): Promise<void> => {
    if (!prepared || records.length === 0 || !files) return
    const source = prepared.source
    const parts = splitImport(source, records)
    const results: ImportResult[] = []
    let failed: string | null = null
    setError(null)
    try {
      for (let i = 0; i < parts.length; i++) {
        const bytes = encodeImport(source, parts[i])
        setSending({ sent: 0, total: bytes.length, part: i + 1, parts: parts.length })
        try {
          const r = await link.importPut(bytes, (sent, total) =>
            setSending({ sent, total, part: i + 1, parts: parts.length })
          )
          results.push(r)
          if (r.approval !== 'approved') break
        } finally {
          bytes.fill(0)
        }
      }
    } catch (e) {
      const message = (e as Error).message
      failed = /unknown kind/.test(message)
        ? 'This maki’s firmware takes no imports: newer firmware does.'
        : message
    } finally {
      setSending(null)
    }
    const names = files.map((c) => ({ id: c.id, name: c.name }))
    // sent (or not): everything read goes, but which files they were, for the trash
    drop(false)
    setDone({ source, results, error: failed, files: names })
    refresh()
  }

  const trash = async (): Promise<void> => {
    if (!done) return
    const failed = await window.maki.imports.trash(done.files.map((f) => f.id))
    setTrashed(
      failed.length === 0
        ? {
            ok: true,
            text: `Moved to the trash. Empty the trash too: until then, the passwords are still on this computer.`
          }
        : {
            ok: false,
            text: failed
              .map((f) => `${f.name} couldn’t be moved (${f.why}): delete it yourself.`)
              .join(' ')
          }
    )
  }

  const finish = (): void => {
    if (done) void window.maki.imports.forget(done.files.map((f) => f.id))
    setDone(null)
    setTrashed(null)
  }

  // a CSV read by columns, with no password column chosen yet: nothing to show until there is
  const needsColumns =
    opened?.state === 'read' &&
    opened.csv !== undefined &&
    (columns ?? opened.csv.used).password < 0
  const ready = linked && vault?.status === 'approved'
  const blocked = !linked
    ? 'Plug maki in to send it.'
    : vault === null
      ? 'This maki’s firmware takes no imports: newer firmware does.'
      : vault?.status === 'locked'
        ? 'maki is locked: enter its PIN on maki first.'
        : vault?.status === 'no phrase'
          ? 'maki has no recovery phrase yet: set one up on maki first.'
          : null
  const added =
    done?.results.reduce((n, r) => n + (r.approval === 'approved' ? r.passkeys : 0), 0) ?? 0
  const approved =
    done !== null && done.results.length > 0 && done.results.every((r) => r.approval === 'approved')

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="download" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>import</Label>
          <p className="mt-2 text-sm leading-relaxed text-subtext1">
            Bring your logins, two-step codes and passkeys over from another password manager:
            Bitwarden, Proton Pass, 1Password, LastPass, KeePassXC, Dashlane, NordPass, Enpass,
            Keeper, Apple Passwords, or a browser’s own. Export from it, choose the file here, and
            go through what maki will get before anything is sent. maki asks you once, on its own
            screen, and adds what it doesn’t have: nothing it holds is overwritten.
          </p>

          {done ? (
            <Result
              done={done}
              approved={approved}
              passkeys={added}
              link={link}
              go={go}
              trashed={trashed}
              trash={() => void trash()}
              finish={finish}
              chooseAgain={() => {
                finish()
                void choose()
              }}
            />
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  small
                  kind={files ? 'quiet' : 'primary'}
                  glyph="file"
                  disabled={reading !== null || sending !== null}
                  onClick={() => void choose()}
                >
                  {files ? 'Choose another…' : 'Choose an export…'}
                </Button>
                {files && (
                  <span className="min-w-0 truncate font-mono text-xs text-overlay1">
                    {files.map((f) => f.name).join(', ')}
                  </span>
                )}
                {files && sending === null && (
                  <button
                    className="text-xs text-overlay1 underline decoration-dotted hover:text-fg"
                    onClick={() => drop(true)}
                  >
                    Cancel
                  </button>
                )}
              </div>
              {reading !== null && (
                <p className="mt-3 text-sm text-subtext0">
                  Reading{reading > 0 ? `… ${Math.round(reading * 100)}%` : '…'}
                </p>
              )}
              {error && <p className="mt-3 text-sm text-yellow">{error}</p>}
              {files && opened && reading === null && (
                <Opening
                  opened={opened}
                  format={format}
                  columns={columns}
                  password={password}
                  setPassword={setPassword}
                  again={again}
                />
              )}
              {prepared && reading === null && !needsColumns && (
                <Preview
                  prepared={prepared}
                  chosen={chosen}
                  skip={skip}
                  setSkip={setSkip}
                  ready={ready}
                  blocked={blocked}
                  sending={sending}
                  send={() => void send(chosen)}
                />
              )}
              {!files && <Exporting />}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

/** What the file was read as, and what the owner can choose: another format, the password, the columns. */
function Opening({
  opened,
  format,
  columns,
  password,
  setPassword,
  again
}: {
  opened: Opened
  format: FormatId | undefined
  columns: Columns | undefined
  password: string
  setPassword: (p: string) => void
  again: (options: { format?: FormatId; columns?: Columns; password?: string }) => void
}): React.JSX.Element {
  const select =
    'w-auto max-w-full rounded-lg border border-surface1 bg-crust/60 px-2 py-1.5 font-mono text-[0.72rem] text-fg outline-none focus:border-peach/70'
  if (opened.state === 'refused') return <p className="mt-3 text-sm text-yellow">{opened.why}</p>
  if (opened.state === 'choose')
    return (
      <div className="mt-3 space-y-2">
        <p className="text-sm text-subtext1">{opened.why} Which is it?</p>
        <select
          aria-label="What it’s from"
          className={select}
          value={format ?? ''}
          onChange={(e) => again({ format: e.target.value as FormatId })}
        >
          <option value="" disabled>
            Choose…
          </option>
          {opened.formats.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
    )
  if (opened.state === 'password')
    return (
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (password) again({ password })
        }}
      >
        <p className="text-sm text-subtext1">
          {opened.wrong
            ? 'That isn’t the export’s password. Try again:'
            : `This is ${opened.format.label}, with a password. Its password opens it here; it isn’t kept.`}
        </p>
        <div className="flex items-end gap-2">
          <Field
            label="The export’s password"
            type="password"
            placeholder="the password you gave it"
            value={password}
            className="w-72"
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button small kind="primary" type="submit" disabled={!password}>
            Open
          </Button>
        </div>
      </form>
    )
  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-subtext1">
        <span>
          {opened.format.id === 'generic-csv'
            ? 'Read as a CSV of logins: which column is which is below.'
            : `Read as ${opened.format.label}${opened.chosen ? ', as you chose.' : opened.sure ? '.' : ': the likeliest, from its columns.'}`}
        </span>
        {opened.others.length > 1 && (
          <select
            aria-label="Read it as"
            className={select}
            value=""
            onChange={(e) => again({ format: e.target.value as FormatId, columns: undefined })}
          >
            <option value="" disabled>
              Something else?
            </option>
            {opened.others
              .filter((f) => f.id !== opened.format.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
          </select>
        )}
      </div>
      {opened.csv && (
        <ColumnChooser
          columns={opened.csv.columns}
          used={columns ?? opened.csv.used}
          change={(c) => again({ columns: c })}
        />
      )}
    </div>
  )
}

/** For a CSV of no known manager: which column is which. Never a password shown, only names. */
function ColumnChooser({
  columns,
  used,
  change
}: {
  columns: { index: number; name: string; looks: string | null }[]
  used: Columns
  change: (c: Columns) => void
}): React.JSX.Element {
  const field = (key: Exclude<keyof Columns, 'header'>, name: string): React.JSX.Element => (
    <label className="block">
      <span className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
        {name}
      </span>
      <select
        aria-label={name}
        value={used[key]}
        onChange={(e) => change({ ...used, [key]: Number(e.target.value) })}
        className="mt-1.5 w-full rounded-lg border border-surface1 bg-crust/60 px-2 py-1.5 font-mono text-[0.72rem] text-fg outline-none focus:border-peach/70"
      >
        <option value={-1}>none</option>
        {columns.map((c) => (
          <option key={c.index} value={c.index}>
            {c.name}
            {c.looks ? `: ${c.looks}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <div className="rounded-lg border border-surface1 p-3">
      <p className="text-xs text-overlay1">
        Its columns aren’t a manager’s maki desktop knows: say which is which, the site and the
        password at least. Only their names show here, and what a column of web or email addresses
        holds: never what’s in a password’s.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {field('url', 'Site')}
        {field('username', 'Username')}
        {field('password', 'Password')}
        {field('title', 'Name')}
        {field('totp', 'Code (TOTP)')}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-subtext1">
        <Toggle
          label="The first row names the columns"
          on={used.header}
          onChange={(header) => change({ ...used, header })}
        />
        The first row names the columns
      </label>
    </div>
  )
}

/**
 * What maki will get, before anything is sent: counts, a row per entry (each can be left out),
 * the other addresses logins won't cover, and what's left out, with why.
 */
function Preview({
  prepared,
  chosen,
  skip,
  setSkip,
  ready,
  blocked,
  sending,
  send
}: {
  prepared: Prepared
  /** the records of the rows still ticked */
  chosen: ImportRecord[]
  skip: Set<number>
  setSkip: (skip: Set<number>) => void
  ready: boolean
  blocked: string | null
  sending: { sent: number; total: number; part: number; parts: number } | null
  send: () => void
}): React.JSX.Element {
  const parts = useMemo(() => splitImport(prepared.source, chosen).length, [prepared, chosen])
  const kinds = (k: ImportRecord['kind']): number => chosen.filter((r) => r.kind === k).length
  const what = list(
    [
      kinds('login') > 0 ? count(kinds('login'), 'login') : null,
      kinds('code') > 0 ? count(kinds('code'), 'code') : null,
      kinds('passkey') > 0 ? count(kinds('passkey'), 'passkey') : null
    ].filter((s): s is string => s !== null)
  )
  const others = prepared.rows.filter((r) => r.others.length > 0)
  const toggle = (i: number): void => {
    const next = new Set(skip)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setSkip(next)
  }
  const all = skip.size === 0
  const th = 'px-3 py-2 font-bold'
  return (
    <div className="mt-4">
      <p className="text-sm text-fg">
        {prepared.records.length === 0
          ? 'Nothing in it for maki.'
          : chosen.length === 0
            ? 'Nothing chosen to send.'
            : `For maki, from ${prepared.source}: ${what}.`}
        {skip.size > 0 && (
          <span className="text-subtext0">
            {' '}
            {count(skip.size, 'entry', 'entries')} unticked, which stay out.
          </span>
        )}
        {prepared.left.length > 0 && (
          <span className="text-subtext0">
            {' '}
            {count(prepared.left.length, 'thing')} left out, below.
          </span>
        )}
      </p>
      {prepared.notes.map((n) => (
        <p key={n} className="mt-1 text-xs text-yellow">
          {n}
        </p>
      ))}

      {prepared.rows.length > 0 && (
        <div className="mt-3 max-h-96 overflow-y-auto rounded-lg border border-surface1">
          <table className="w-full table-fixed text-left text-xs">
            <thead className="sticky top-0 bg-mantle font-mono text-[0.6rem] tracking-[0.14em] text-overlay1 uppercase">
              <tr>
                <th className="w-9 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Send them all"
                    checked={all}
                    onChange={() =>
                      setSkip(all ? new Set(prepared.rows.map((_, i) => i)) : new Set())
                    }
                    className="accent-peach"
                  />
                </th>
                <th className={`w-[28%] ${th}`}>Site</th>
                <th className={`w-[22%] ${th}`}>Username</th>
                <th className={`w-[29%] ${th}`}>Brings</th>
                <th className={th}>Name there</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface0">
              {prepared.rows.slice(0, ROWS).map((r, i) => (
                <tr key={i} className={`align-top ${skip.has(i) ? 'opacity-40' : ''}`}>
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Send ${r.site || r.title}`}
                      checked={!skip.has(i)}
                      onChange={() => toggle(i)}
                      className="accent-peach"
                    />
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-fg" title={r.site}>
                    {r.site || <span className="text-overlay0">no site</span>}
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-subtext1" title={r.username}>
                    {r.username || <span className="text-overlay0">none</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {r.password && <Badge kind="later">password</Badge>}
                      {r.codes > 0 && <Badge kind="info">code</Badge>}
                      {r.passkeys > 0 && <Badge kind="next">passkey</Badge>}
                    </div>
                  </td>
                  <td className="truncate px-3 py-1.5 text-subtext0" title={r.title}>
                    {r.title}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {prepared.rows.length > ROWS && (
            <p className="px-3 py-2 text-xs text-overlay1">
              and {count(prepared.rows.length - ROWS, 'more')}, sent with the rest
            </p>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-3 text-xs text-overlay1">
          <p>
            maki keeps one site for a login, and its subdomains with it (a login for github.com
            serves gist.github.com). These logins were for other addresses too, where maki won’t
            offer them:
          </p>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto pl-3">
            {others.map((r, i) => (
              <li key={i}>
                <span className="font-mono text-subtext1">{r.site}</span>: also{' '}
                {r.others.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {prepared.left.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-yellow">Left out, with why:</p>
          <div className="mt-1.5 max-h-72 overflow-y-auto rounded-lg border border-surface1">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="sticky top-0 bg-mantle font-mono text-[0.6rem] tracking-[0.14em] text-overlay1 uppercase">
                <tr>
                  <th className={`w-[14%] ${th}`}>Where</th>
                  <th className={`w-[20%] ${th}`}>Name there</th>
                  <th className={`w-[22%] ${th}`}>What</th>
                  <th className={th}>Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface0">
                {prepared.left.map((l, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-3 py-1.5 font-mono text-overlay1">{l.where}</td>
                    <td className="truncate px-3 py-1.5 text-subtext1" title={l.title}>
                      {l.title}
                    </td>
                    <td className="px-3 py-1.5 text-subtext1">{l.what}</td>
                    <td className="px-3 py-1.5 text-subtext0">{upper(l.why)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {kinds('passkey') > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-subtext1">
          About the passkeys: their keys weren’t made on maki, and they’ve been in a file on this
          computer. maki marks them imported. They aren’t made from maki’s recovery phrase, as its
          own are, so only a backup brings them back to a restored maki.
        </p>
      )}

      {prepared.records.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            small
            kind="primary"
            glyph="send"
            disabled={!ready || sending !== null || chosen.length === 0}
            onClick={send}
          >
            {sending
              ? sending.sent < sending.total
                ? `Sending${sending.parts > 1 ? ` part ${sending.part} of ${sending.parts}` : ''}… ${Math.round((100 * sending.sent) / sending.total)}%`
                : 'Say yes on maki…'
              : parts > 1
                ? `Send to maki, in ${parts} parts`
                : 'Send to maki'}
          </Button>
          {blocked && <span className="text-sm text-yellow">{blocked}</span>}
          {!blocked && sending === null && (
            <span className="text-xs text-overlay1">
              {parts > 1
                ? `It’s more than maki takes at once (${MAX_RECORDS} records, ${MAX_IMPORT / 1024} KiB), so it goes in ${parts} parts, and maki asks for each.`
                : 'maki asks you on its own screen, naming where it’s from and how many.'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** What came of an import: what maki added, a backup for imported passkeys, the export to the trash. */
function Result({
  done,
  approved,
  passkeys,
  link,
  go,
  trashed,
  trash,
  finish,
  chooseAgain
}: {
  done: {
    source: string
    results: ImportResult[]
    error: string | null
    files: { id: number; name: string }[]
  }
  approved: boolean
  passkeys: number
  link: Link
  go: (page: Page) => void
  trashed: { ok: boolean; text: string } | null
  trash: () => void
  finish: () => void
  chooseAgain: () => void
}): React.JSX.Element {
  const names = done.files.map((f) => f.name).join(', ')
  return (
    <div className="mt-4 space-y-3 text-sm">
      {done.results.map((r, i) => (
        <p key={i} className={r.approval === 'approved' ? 'text-green' : 'text-yellow'}>
          {done.results.length > 1 ? `Part ${i + 1}: ` : ''}
          {importSays(r)}
        </p>
      ))}
      {done.error && <p className="text-yellow">{upper(done.error)}</p>}

      {passkeys > 0 && (
        <div className="rounded-lg border border-peach/40 bg-peach/[0.06] p-3">
          <p className="text-subtext1">
            Make a backup now, and keep a copy of it off this computer. The passkeys from{' '}
            {done.source} aren’t made from maki’s recovery phrase: if maki is lost or wiped, only a
            backup brings them back. maki desktop keeps maki’s backups, encrypted, in its folder.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              small
              kind="primary"
              glyph="shield"
              disabled={!link.state.linked || link.backingUp}
              onClick={() => void link.backupNow()}
            >
              {link.backingUp ? 'Backing up…' : 'Back up now'}
            </Button>
            <Button small onClick={() => go('backups')}>
              Backups
            </Button>
          </div>
        </div>
      )}

      {approved && (
        <div className="rounded-lg border border-surface1 p-3">
          {trashed ? (
            <p className={trashed.ok ? 'text-green' : 'text-yellow'}>{trashed.text}</p>
          ) : (
            <>
              <p className="text-subtext1">
                {names} holds your passwords in the clear. Now that maki has them, move{' '}
                {done.files.length === 1 ? 'it' : 'them'} to the trash?
              </p>
              <div className="mt-2">
                <Button small kind="danger" glyph="trash" onClick={trash}>
                  Move to the trash
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex gap-3">
        <Button small onClick={finish}>
          Done
        </Button>
        {!approved && (
          <Button small kind="ghost" glyph="file" onClick={chooseAgain}>
            Choose the export again
          </Button>
        )}
      </div>
    </div>
  )
}

/** Where each manager's export is, for the owner who hasn't made one yet. */
function Exporting(): React.JSX.Element {
  const how: [string, string][] = [
    [
      'Bitwarden',
      'Export vault (Tools, in its web app; File, in its desktop app), as .json, or .json with a password of its own. Its .csv carries no passkeys.'
    ],
    [
      'Proton Pass',
      'Settings › Export, from its web app, browser extension or desktop app, without encryption: the zip carries passkeys, the CSV doesn’t.'
    ],
    ['1Password', 'File › Export, as 1PUX (or CSV). 1Password exports no passkeys.'],
    ['LastPass', 'Export, from its browser extension: a CSV, with no passkeys.'],
    [
      'KeePassXC',
      'Database › Export, as XML, which carries its passkeys, or CSV. KeePass 2: File › Export › KeePass XML (2.x).'
    ],
    ['Dashlane', 'Export data, as CSV (not the DASH file). Dashlane exports no passkeys.'],
    [
      'Chrome, Edge, Brave',
      'Password Manager › Settings › Export passwords: a CSV, with no passkeys.'
    ],
    ['Firefox', 'about:logins › ⋯ › Export Passwords.'],
    [
      'Apple Passwords',
      'File › Export All Passwords to File; on an iPhone, Settings › Apps › Safari › Export. No passkeys.'
    ],
    ['NordPass', 'Settings › Export Items: a CSV, with no codes and no passkeys.'],
    ['Enpass', 'File › Export, as .json. Enpass exports no passkeys.'],
    ['Keeper', 'Settings › Export, as JSON, which carries passkeys, or CSV.'],
    [
      'Others',
      'A CSV of logins (you say which column is which), or a Credential Exchange (CXF) JSON file.'
    ]
  ]
  return (
    <details className="mt-4 text-xs text-overlay1">
      <summary className="cursor-pointer text-subtext0 hover:text-fg">
        Where to find the export
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {how.map(([who, where]) => (
          <div key={who} className="contents">
            <dt className="font-mono text-subtext1">{who}</dt>
            <dd>{where}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2">
        An export holds your passwords in the clear. maki desktop reads it and keeps nothing of it,
        and offers to move it to the trash once maki has what’s in it.
      </p>
    </details>
  )
}
