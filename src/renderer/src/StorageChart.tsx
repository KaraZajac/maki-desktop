import type { AppSpace, InstalledApp } from '@shared/client'
import { APP_COLOURS, bytes } from './ui'

/** Each app's colour, the same wherever it's shown: by its place in maki's list (in order of ID). */
export function appColours(apps: InstalledApp[] | null): Record<string, string> {
  return Object.fromEntries((apps ?? []).map((a, i) => [a.id, APP_COLOURS[i % APP_COLOURS.length]]))
}

/** What an app takes of maki's room for apps: its bundle, and the storage it asks for. */
export const takes = (a: InstalledApp): number => a.bundle + a.storage

/**
 * maki's room for apps as a bar: a segment for each app, biggest first, and what's free. With
 * `compact`, just the bar; otherwise what's taken and free, a scale and a legend too.
 */
export function StorageChart({
  space,
  apps,
  compact = false
}: {
  space: AppSpace | null
  apps: InstalledApp[]
  compact?: boolean
}): React.JSX.Element {
  const colours = appColours(apps)
  const taken = space?.taken ?? apps.reduce((n, a) => n + takes(a), 0)
  const total = space?.space ?? 0
  const free = Math.max(0, total - taken)
  const left = space ? Math.max(0, space.maxApps - space.apps) : null
  const shown = [...apps].sort((a, b) => takes(b) - takes(a))
  // how wide a segment is: in proportion, but never too thin to see
  const width = (n: number): string =>
    total ? `max(${((n / total) * 100).toFixed(3)}%, 5px)` : `${100 / Math.max(1, apps.length)}%`

  const bar = (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-surface0/60 ring-1 ring-surface1/50 ring-inset ${compact ? 'h-2.5' : 'h-5'}`}
      role="img"
      aria-label={`${bytes(taken)} of ${bytes(total)} taken by ${apps.length} apps`}
    >
      {shown.map((a) => (
        <div
          key={a.id}
          title={`${a.name}: ${bytes(takes(a))} (${bytes(a.bundle)} app, ${bytes(a.storage)} storage)`}
          className="h-full shrink-0 border-r-2 border-crust/80 transition-[width] duration-500"
          style={{ width: width(takes(a)), background: colours[a.id] }}
        />
      ))}
    </div>
  )
  if (compact) return bar

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div className="font-mono">
          <span className="text-[1.6rem] font-bold tracking-[-0.03em] text-fg">{bytes(taken)}</span>
          {total > 0 && <span className="ml-2 text-sm text-overlay1">of {bytes(total)}</span>}
        </div>
        {space && (
          <div className="text-right font-mono text-[0.72rem] leading-relaxed text-subtext0">
            <div>
              <span className="text-green">{bytes(free)}</span> free
            </div>
            <div>
              room for <span className="text-fg">{left}</span> more {left === 1 ? 'app' : 'apps'}
              <span className="text-overlay0"> of {space.maxApps}</span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3">{bar}</div>

      {total > 0 && (
        <div className="mt-1.5 flex justify-between font-mono text-[0.6rem] text-overlay0">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f}>{f === 0 ? '0' : bytes(total * f)}</span>
          ))}
        </div>
      )}

      <ul className="mt-5 grid grid-cols-2 gap-x-8 gap-y-2.5 xl:grid-cols-3">
        {shown.map((a) => (
          <li key={a.id} className="flex min-w-0 items-center gap-2.5">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: colours[a.id] }}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-subtext1">{a.name}</span>
            <span className="font-mono text-[0.72rem] text-overlay1">{bytes(takes(a))}</span>
          </li>
        ))}
        {total > 0 && (
          <li className="flex min-w-0 items-center gap-2.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-surface2 bg-surface0" />
            <span className="min-w-0 flex-1 truncate text-sm text-overlay1">Free</span>
            <span className="font-mono text-[0.72rem] text-overlay1">{bytes(free)}</span>
          </li>
        )}
      </ul>
    </div>
  )
}
