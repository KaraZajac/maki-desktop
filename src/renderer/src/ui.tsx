/**
 * maki desktop's look, in pieces: maki.netslum.io's (Catppuccin Mocha, with the peach of the
 * salmon in maki's roll for what to do, and the green of the nori for what's done), labels in
 * monospace capitals, and maki's own 1-bit icons drawn pixel for pixel.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { iconPixels } from '@shared/bundle'

export { ago, bytes, readable } from './format'

/** maki's mark: a maki roll seen face on (the nori, the rice, the salmon). */
export function MakiMark({ className = 'h-9 w-9' }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <circle cx="32" cy="32" r="30" fill="#1d3a2a" stroke="#4d8a66" strokeWidth="1.2" />
      <circle cx="32" cy="32" r="25" fill="#f3efe6" />
      <circle cx="32" cy="32" r="11" fill="#ff7a59" />
    </svg>
  )
}

const glyphs: Record<string, ReactNode> = {
  overview: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  apps: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
    </>
  ),
  wallet: (
    <>
      <path d="M5 8V6.5A2.5 2.5 0 0 1 7.5 4H17v4" />
      <rect x="4" y="8" width="16" height="12" rx="2.5" />
      <circle cx="16" cy="14" r="1.2" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6.5 8h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16.5V21" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5.5c0 4.2 3 7.8 7 9.5 4-1.7 7-5.3 7-9.5V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  activity: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  refresh: (
    <>
      <path d="M19.5 10A8 8 0 0 0 5.2 7.5L4 9" />
      <path d="M4 4v5h5" />
      <path d="M4.5 14a8 8 0 0 0 14.3 2.5L20 15" />
      <path d="M20 20v-5h-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 20h14" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4h6v3" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" />
    </>
  ),
  store: (
    <>
      <path d="M4 9h16l-1.2 10a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8z" />
      <path d="M8.5 9V7a3.5 3.5 0 0 1 7 0v2" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m7 9 3 3-3 3M12.5 15H17" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  usb: (
    <>
      <path d="M12 3v14" />
      <path d="m9 6 3-3 3 3" />
      <path d="M12 13 7.5 10.5V8.5M12 15l4.5-2.5V10" />
      <circle cx="12" cy="19" r="2" />
      <rect x="15.5" y="8" width="2" height="2" />
      <circle cx="7.5" cy="7.5" r="1" />
    </>
  ),
  bitcoin: (
    <>
      <path d="M9 5.5v13M12 4v2M12 18v2M9 6.5h5a2.75 2.75 0 0 1 0 5.5H9h5.5a3 3 0 0 1 0 6H9" />
    </>
  ),
  ethereum: (
    <>
      <path d="m12 3 6 9.5-6 3.5-6-3.5z" />
      <path d="m6 14 6 7 6-7-6 3.5z" />
    </>
  ),
  solana: (
    <>
      <path d="M7.5 6h12l-3 3h-12z" />
      <path d="M4.5 10.5h12l3 3h-12z" />
      <path d="M7.5 15h12l-3 3h-12z" />
    </>
  ),
  monero: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 15.5H7.5V9l4.5 4.5L16.5 9v6.5h4" />
    </>
  ),
  litecoin: (
    <>
      <path d="M10 4.5v14h7.5M6.5 13.5l7.5-3.5" />
    </>
  ),
  dogecoin: (
    <>
      <path d="M8.5 5H12a7 7 0 0 1 0 14H8.5zM5.5 12H13" />
    </>
  ),
  bitcoincash: (
    <g transform="rotate(-18 12 12)">
      <path d="M9 5.5v13M12 4v2M12 18v2M9 6.5h5a2.75 2.75 0 0 1 0 5.5H9h5.5a3 3 0 0 1 0 6H9" />
    </g>
  ),
  kaspa: (
    <>
      <path d="M8 4.5v15M8.5 12 16 4.5M8.5 12l7.5 7.5" />
    </>
  ),
  cosmos: (
    <>
      <ellipse cx="12" cy="12" rx="9.5" ry="3.5" transform="rotate(55 12 12)" />
      <ellipse cx="12" cy="12" rx="9.5" ry="3.5" transform="rotate(-55 12 12)" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  tron: (
    <>
      <path d="m3 4 18 4.5L11.5 21z" />
      <path d="m3 4 11 7.5 7-3M14 11.5 11.5 21" />
    </>
  ),
  stellar: (
    <>
      <path d="M17.6 7.2A6.5 6.5 0 0 0 5.6 13.4M6.4 16.8a6.5 6.5 0 0 0 12-6.2" />
      <path d="m2.5 15.5 19-7.5M2.5 18.5l19-7.5" />
    </>
  ),
  xrp: (
    <>
      <path d="M3.5 5c2.5 0 4.5 6 8.5 6s6-6 8.5-6M3.5 19c2.5 0 4.5-6 8.5-6s6 6 8.5 6" />
    </>
  ),
  near: (
    <>
      <path d="M6.5 19V5l11 14V5" />
    </>
  ),
  sui: (
    <>
      <path d="M12 3c3.5 4.5 6.5 7.5 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10.5 8.5 7.5 12 3z" />
      <path d="M8.5 15c1.2-1.4 2.3-1.4 3.5 0s2.3 1.4 3.5 0" />
    </>
  ),
  aptos: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M4 9h6M14 9h6M3 13h18M5 17h14" />
    </>
  ),
  cardano: (
    <>
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="6.5" r="1" />
      <circle cx="12" cy="17.5" r="1" />
      <circle cx="7.2" cy="9.2" r="1" />
      <circle cx="16.8" cy="9.2" r="1" />
      <circle cx="7.2" cy="14.8" r="1" />
      <circle cx="16.8" cy="14.8" r="1" />
      <circle cx="12" cy="2.5" r=".6" />
      <circle cx="12" cy="21.5" r=".6" />
      <circle cx="3.8" cy="7.2" r=".6" />
      <circle cx="20.2" cy="7.2" r=".6" />
      <circle cx="3.8" cy="16.8" r=".6" />
      <circle cx="20.2" cy="16.8" r=".6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M16 7l2.5 2.5M14 9l2 2" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4 2.8 19.5h18.4z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  qr: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h1M18 14h2" />
    </>
  ),
  send: (
    <>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </>
  ),
  receive: (
    <>
      <path d="M17 7 7 17" />
      <path d="M16 17H7V8" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      <path d="M12 15v2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  )
}

/** A line icon, 24 units square, in the text's colour. */
export function Glyph({
  name,
  className = 'h-4 w-4'
}: {
  name: keyof typeof glyphs | string
  className?: string
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {glyphs[name]}
    </svg>
  )
}

export function Card({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <section className={`card p-5 ${className}`}>{children}</section>
}

/** A section's label, as the site has them: monospace capitals in peach, after a short rule. */
export function Label({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <h2
      className={`flex items-center gap-2.5 font-mono text-[0.68rem] font-bold uppercase tracking-[0.18em] text-peach ${className}`}
    >
      <span className="h-0.5 w-5 rounded bg-peach" />
      {children}
    </h2>
  )
}

export function PageHeader({
  label,
  title,
  lede,
  actions
}: {
  label: string
  title: ReactNode
  lede?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <header className="mb-7 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <Label>{label}</Label>
        <h1 className="mt-2.5 font-mono text-[2rem] font-bold leading-none tracking-[-0.035em] text-fg">
          {title}
        </h1>
        {lede && (
          <p className="mt-3 max-w-2xl text-[0.95rem] leading-relaxed text-subtext1">{lede}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  )
}

const buttonKinds = {
  primary: 'border-peach bg-peach text-crust hover:border-yellow hover:bg-yellow',
  ghost: 'border-peach/60 text-peach hover:border-peach hover:bg-peach/10',
  quiet: 'border-surface1 bg-surface0/40 text-subtext1 hover:border-surface2 hover:text-fg',
  danger: 'border-red/40 text-red hover:border-red/70 hover:bg-red/10'
}

export function Button({
  kind = 'quiet',
  small = false,
  glyph,
  children,
  className = '',
  ...rest
}: {
  kind?: keyof typeof buttonKinds
  small?: boolean
  glyph?: string
  children?: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const size = small ? 'gap-1.5 px-2.5 py-1.5 text-[0.7rem]' : 'gap-2 px-3.5 py-2 text-[0.76rem]'
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center rounded-lg border font-mono font-bold tracking-wide whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40 ${size} ${buttonKinds[kind]} ${className}`}
    >
      {glyph && <Glyph name={glyph} className={small ? 'h-3.5 w-3.5' : 'h-4 w-4'} />}
      {children}
    </button>
  )
}

const badgeKinds = {
  built: 'border-green/40 bg-green/[0.07] text-green',
  next: 'border-peach/40 bg-peach/[0.07] text-peach',
  later: 'border-surface2 text-overlay1',
  warn: 'border-yellow/40 bg-yellow/[0.07] text-yellow',
  danger: 'border-red/40 bg-red/[0.08] text-red',
  info: 'border-lavender/40 bg-lavender/[0.07] text-lavender'
}

/** A small pill, as the site marks what's built, next and later. */
export function Badge({
  kind = 'later',
  children
}: {
  kind?: keyof typeof badgeKinds
  children: ReactNode
}): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[0.1rem] font-mono text-[0.62rem] font-bold uppercase tracking-[0.08em] whitespace-nowrap ${badgeKinds[kind]}`}
    >
      {children}
    </span>
  )
}

/** A dot that says whether maki is here: green and still when it is, breathing when it's looked for. */
export function Dot({
  on,
  className = ''
}: {
  on: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span className={`relative inline-flex h-2 w-2 ${className}`}>
      {on && <span className="absolute inset-0 rounded-full bg-green opacity-40 blur-[3px]" />}
      <span
        className={`relative h-2 w-2 rounded-full ${on ? 'bg-green' : 'breathe bg-overlay0'}`}
      />
    </span>
  )
}

/**
 * An app's icon as maki's screen shows it, 64 pixels square, light on the OLED's black; or its
 * initial, for an app without one.
 */
export function PixelIcon({
  icon,
  name,
  className = 'h-14 w-14'
}: {
  icon: Uint32Array | null
  name: string
  className?: string
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !icon) return
    const image = ctx.createImageData(64, 64)
    iconPixels(icon).forEach((light, i) => {
      image.data.set(light ? [243, 239, 230, 255] : [10, 10, 16, 255], i * 4)
    })
    ctx.putImageData(image, 0, 0)
  }, [icon])
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-[22%] border border-surface1/70 bg-oled shadow-[0_8px_24px_-12px_rgba(0,0,0,0.9)] ${className}`}
    >
      {icon ? (
        <canvas
          ref={canvas}
          width={64}
          height={64}
          className="h-full w-full"
          style={{ imageRendering: 'pixelated' }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center font-mono text-xl font-bold text-rice">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  )
}

/** A choice of a few, side by side: the chosen one in peach. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled = false
}: {
  value: T
  options: [T, string][]
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex rounded-lg border border-surface1 bg-crust/50 p-0.5 font-mono text-[0.68rem]"
    >
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 font-bold tracking-wide whitespace-nowrap transition-colors disabled:opacity-40 ${
            value === v ? 'bg-peach text-crust' : 'text-subtext0 hover:text-fg'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** A text field as the window has them: monospace for what's typed, a unit after it if it has one. */
export function Field({
  label,
  unit,
  hint,
  className = '',
  ...rest
}: {
  label: string
  unit?: ReactNode
  hint?: ReactNode
} & React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <label className={`block ${className}`}>
      <span className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
        {label}
      </span>
      <span className="mt-1.5 flex items-center rounded-lg border border-surface1 bg-crust/60 transition-colors focus-within:border-peach/70">
        <input
          {...rest}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-overlay0"
        />
        {unit && <span className="pr-3 font-mono text-xs text-overlay1">{unit}</span>}
      </span>
      {hint && <span className="mt-1 block text-xs text-overlay1">{hint}</span>}
    </label>
  )
}

/** A switch, for settings that are on or off. */
export function Toggle({
  on,
  onChange,
  disabled = false,
  label
}: {
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  label: string
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
        on ? 'border-green/60 bg-green/70' : 'border-surface2 bg-surface0'
      }`}
    >
      <span
        className={`absolute top-[1px] h-4 w-4 rounded-full shadow transition-all ${on ? 'left-[1.05rem] bg-crust' : 'left-[1px] bg-overlay1'}`}
      />
    </button>
  )
}

/** The colours apps have in the storage chart, in order: the site's, peach first. */
export const APP_COLOURS = [
  '#fab387',
  '#a6e3a1',
  '#94e2d5',
  '#89b4fa',
  '#f9e2af',
  '#cba6f7',
  '#f5c2e7',
  '#89dceb',
  '#eba0ac',
  '#b4befe',
  '#74c7ec',
  '#f2cdcd'
]
