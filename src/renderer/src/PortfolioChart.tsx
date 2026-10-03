import { useEffect, useRef, useState } from 'react'
import type { Day } from '@shared/portfolio'
import { money, type Currency } from '@shared/prices'
import { Card, Label } from './ui'

/** The line's colour: the allocation's first, a step of maki's blue for a dark card. */
const LINE = '#3987e5'
/** The card under the chart, for the ring round a point. */
const SURFACE = '#1e1e2e'
const DAY_MS = 86_400_000
const HEIGHT = 168
/** Room for the values on the left, and the dates below. */
const LEFT = 64
const RIGHT = 12
const TOP = 12
const BOTTOM = 26

/** A day as kept (2026-10-02), as a number of days: the next day is one more. */
const dayNumber = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}
const dateOf = (day: string, year = false): string => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(year && { year: 'numeric' })
  })
}

/** A round number at or above `n`, for the top of the scale, which halves to a round one too. */
function roundUp(n: number): number {
  if (n <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(n))
  return ([1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find((f) => f * p >= n) ?? 10) * p
}

/**
 * The total, day by day: a point for each day the Portfolio looked everything up, at that day's
 * prices, in the currency chosen (days in another aren't shown). Days it wasn't opened have no
 * point, and the line breaks there rather than guess. A table of the same, a press away.
 */
export function PortfolioChart({
  days,
  currency
}: {
  days: Day[]
  currency: Currency
}): React.JSX.Element | null {
  const points = days.filter((d) => d.currency === currency)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const watch = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)))
    watch.observe(el)
    return () => watch.disconnect()
  }, [points.length >= 2, table])
  if (points.length < 2) return null

  const first = dayNumber(points[0].day)
  const last = dayNumber(points[points.length - 1].day)
  const top = roundUp(Math.max(...points.map((p) => p.total)))
  const x = (day: string): number =>
    LEFT + ((dayNumber(day) - first) / Math.max(1, last - first)) * (width - LEFT - RIGHT)
  const y = (v: number): number => TOP + (1 - v / top) * (HEIGHT - TOP - BOTTOM)
  // runs of days one after another: a line through each, a gap between
  const runs: Day[][] = []
  for (const p of points) {
    const run = runs[runs.length - 1]
    if (run && dayNumber(p.day) - dayNumber(run[run.length - 1].day) === 1) run.push(p)
    else runs.push([p])
  }
  const short = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    notation: 'compact',
    maximumFractionDigits: 1
  })
  const ticks = [0, top / 2, top]
  const shown = hover === null ? null : points[hover]

  const near = (clientX: number, el: SVGSVGElement): number => {
    const at = clientX - el.getBoundingClientRect().left
    let best = 0
    for (const [i, p] of points.entries())
      if (Math.abs(x(p.day) - at) < Math.abs(x(points[best].day) - at)) best = i
    return best
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>day by day</Label>
        <button
          className="font-mono text-[0.68rem] text-peach hover:text-yellow"
          onClick={() => setTable(!table)}
        >
          {table ? 'As a chart' : 'As a table'}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-overlay1">
        The total on each day the page looked everything up, at that day’s prices. A day it wasn’t
        opened has no point: the line breaks there.
      </p>
      {table ? (
        <div className="mt-4 max-h-64 overflow-y-auto">
          <table className="w-full">
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.day} className="border-b border-surface0/60 last:border-b-0">
                  <td className="py-1.5 text-sm text-subtext0">{dateOf(p.day, true)}</td>
                  <td className="py-1.5 text-right font-mono text-sm text-fg tabular-nums">
                    {money(p.total, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={box} className="relative mt-4">
          <svg
            width={width}
            height={HEIGHT}
            className="block touch-none"
            role="img"
            aria-label={`The total from ${dateOf(points[0].day, true)} to ${dateOf(points[points.length - 1].day, true)}: ${money(points[0].total, currency)} to ${money(points[points.length - 1].total, currency)}`}
            onPointerMove={(e) => setHover(near(e.clientX, e.currentTarget))}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={LEFT}
                  x2={width - RIGHT}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={t === 0 ? '#45475a' : '#313244'}
                  strokeWidth={1}
                />
                <text
                  x={LEFT - 8}
                  y={y(t)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-overlay1 font-mono text-[0.62rem] tabular-nums"
                >
                  {short.format(t)}
                </text>
              </g>
            ))}
            {[points[0], points[points.length - 1]].map((p, i) => (
              <text
                key={p.day}
                x={x(p.day)}
                y={HEIGHT - 6}
                textAnchor={i === 0 ? 'start' : 'end'}
                className="fill-overlay1 font-mono text-[0.62rem]"
              >
                {dateOf(p.day, true)}
              </text>
            ))}
            {runs.map((run) =>
              run.length === 1 ? (
                <circle
                  key={run[0].day}
                  cx={x(run[0].day)}
                  cy={y(run[0].total)}
                  r={4}
                  fill={LINE}
                  stroke={SURFACE}
                  strokeWidth={2}
                />
              ) : (
                <path
                  key={run[0].day}
                  d={run.map((p, i) => `${i ? 'L' : 'M'}${x(p.day)},${y(p.total)}`).join(' ')}
                  fill="none"
                  stroke={LINE}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )
            )}
            {/* the newest, where the line ends */}
            <circle
              cx={x(points[points.length - 1].day)}
              cy={y(points[points.length - 1].total)}
              r={4}
              fill={LINE}
              stroke={SURFACE}
              strokeWidth={2}
            />
            {shown && (
              <g pointerEvents="none">
                <line
                  x1={x(shown.day)}
                  x2={x(shown.day)}
                  y1={TOP}
                  y2={HEIGHT - BOTTOM}
                  stroke="#585b70"
                  strokeWidth={1}
                />
                <circle
                  cx={x(shown.day)}
                  cy={y(shown.total)}
                  r={4}
                  fill={LINE}
                  stroke={SURFACE}
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>
          {shown && (
            <div
              className="pointer-events-none absolute top-0 rounded-lg border border-surface1 bg-crust/95 px-3 py-2 shadow-lg"
              style={{
                left: Math.min(Math.max(0, x(shown.day) - 80), width - 160),
                width: 160
              }}
            >
              <div className="font-mono text-sm font-bold text-fg">
                {money(shown.total, currency)}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[0.7rem] text-overlay1">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: LINE }} />
                {dateOf(shown.day, true)}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
