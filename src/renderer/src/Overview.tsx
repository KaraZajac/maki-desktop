import { iconPixels } from '@shared/bundle'
import type { Link } from '@shared/link'
import { TimeState } from '@shared/protocol'
import type { Apps } from './apps-state'
import { StorageChart } from './StorageChart'
import { ago, Badge, Button, bytes, Dot, Glyph, Label, MakiMark, PageHeader, Toggle } from './ui'

export type Page = 'overview' | 'apps' | 'wallets' | 'connections' | 'backups'

function formatClock(utcMs: number, tzOffsetS: number): string {
  return new Date(utcMs + tzOffsetS * 1000).toISOString().slice(11, 19)
}

/**
 * maki's core module, drawn: its 128-pixel OLED with the time maki keeps (or its mark, while it
 * isn't linked), and its three buttons, the centre in peach.
 */
function Device({
  time,
  state,
  linked,
  name
}: {
  time: string | null
  state: number | null
  linked: boolean
  /** this maki's own name, on its bar */
  name: string
}): React.JSX.Element {
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  const tone =
    state === TimeState.VERIFIED
      ? '#a6e3a1'
      : state === TimeState.UNVERIFIED
        ? '#f9e2af'
        : '#6c7086'
  const said =
    state === TimeState.VERIFIED
      ? 'VERIFIED'
      : state === TimeState.UNVERIFIED
        ? 'UNVERIFIED'
        : 'NOT SET'
  return (
    <svg
      viewBox="0 0 220 280"
      className="h-[17rem] w-auto drop-shadow-[0_28px_36px_rgba(0,0,0,0.6)]"
      aria-hidden
    >
      <defs>
        <linearGradient id="maki-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a3b52" />
          <stop offset="1" stopColor="#1b1b2a" />
        </linearGradient>
        <radialGradient id="maki-screen" cx="0.5" cy="0.35" r="0.8">
          <stop offset="0" stopColor="#151521" />
          <stop offset="1" stopColor="#07070c" />
        </radialGradient>
        <filter id="maki-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect
        x="12"
        y="10"
        width="196"
        height="260"
        rx="30"
        fill="url(#maki-body)"
        stroke="#585b70"
        strokeWidth="1.4"
      />
      <rect
        x="13"
        y="11"
        width="194"
        height="258"
        rx="29"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.05"
      />
      <rect x="92" y="22" width="36" height="7" rx="3.5" fill="#11111b" />
      <rect x="32" y="42" width="156" height="156" rx="14" fill="#11111b" stroke="#45475a" />
      <rect x="46" y="56" width="128" height="128" rx="3" fill="url(#maki-screen)" />
      {linked ? (
        <g filter="url(#maki-glow)" fill="#f3efe6" fontFamily={mono}>
          <text x="51" y="69" fontSize="9.5" fontWeight="700">
            {name}
          </text>
          <rect x="49" y="73" width="122" height="1" />
          <text
            x="110"
            y="128"
            fontSize="27"
            fontWeight="700"
            textAnchor="middle"
            letterSpacing="-0.5"
          >
            {time?.slice(0, 5) ?? '--:--'}
          </text>
          <text x="110" y="146" fontSize="11" textAnchor="middle" fill="#bac2de">
            {time?.slice(6) ?? '--'}
          </text>
          <text x="110" y="172" fontSize="7.5" textAnchor="middle" letterSpacing="1.6" fill={tone}>
            {said}
          </text>
        </g>
      ) : (
        <g opacity="0.55">
          <g transform="translate(86 90) scale(0.75)">
            <circle cx="32" cy="32" r="30" fill="#1d3a2a" stroke="#4d8a66" strokeWidth="1.2" />
            <circle cx="32" cy="32" r="25" fill="#f3efe6" />
            <circle cx="32" cy="32" r="11" fill="#ff7a59" />
          </g>
          <text
            x="110"
            y="166"
            fontSize="8"
            textAnchor="middle"
            letterSpacing="1.4"
            fill="#7f849c"
            fontFamily={mono}
          >
            NOT LINKED
          </text>
        </g>
      )}
      <circle cx="64" cy="228" r="11" fill="#313244" stroke="#585b70" />
      <circle cx="110" cy="228" r="13" fill="#fab387" />
      <circle cx="110" cy="228" r="13" fill="none" stroke="#ffffff" strokeOpacity="0.25" />
      <circle cx="156" cy="228" r="11" fill="#313244" stroke="#585b70" />
      <text
        x="110"
        y="259"
        fontSize="8"
        textAnchor="middle"
        letterSpacing="3.5"
        fill="#6c7086"
        fontFamily={mono}
      >
        MAKI
      </text>
    </svg>
  )
}

function Stat({
  label,
  go,
  children
}: {
  label: string
  go?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={go}
      className="card group flex min-h-[9.5rem] flex-col p-5 text-left transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-peach/40"
    >
      <div className="flex w-full items-center justify-between">
        <Label>{label}</Label>
        <Glyph
          name="chevron"
          className="h-4 w-4 text-overlay0 transition-colors group-hover:text-peach"
        />
      </div>
      <div className="mt-4 flex-1">{children}</div>
    </button>
  )
}

/** maki at a glance: whether it's linked, its clock, and what's on it. */
export function Overview({
  link,
  apps,
  storeName,
  backup,
  go,
  connectFake,
  allow
}: {
  link: Link
  apps: Apps
  storeName: string | null
  backup: { at: number; bytes: number } | null
  go: (page: Page) => void
  connectFake: () => void
  allow: () => void
}): React.JSX.Element {
  const s = link.state
  const timeState = s.linked ? s.status.timeState : null
  const badgeNow =
    s.linked && s.status.utcMs > 0 ? s.status.utcMs + (Date.now() - s.status.at) : null
  const drift = badgeNow !== null ? (badgeNow - Date.now()) / 1000 : null
  const time = badgeNow !== null && s.linked ? formatClock(badgeNow, s.status.tzOffsetS) : null
  const index = link.store?.index
  const updates =
    index?.apps.filter((a) => apps.apps?.some((i) => i.id === a.id && i.version < a.version))
      .length ?? 0
  const verifiedBy = link.report?.servers.filter((srv) => srv.result === 'verified').length ?? 0

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="overview"
        title={s.linked ? s.hello.name : 'maki'}
        lede="A security key that shows you what you’re signing. maki desktop keeps it linked, its clock verified and its backups safe, and brings it apps."
      />

      <section className="card relative overflow-hidden p-7">
        <div className="pointer-events-none absolute -top-24 -left-16 h-72 w-72 rounded-full bg-peach/10 blur-3xl" />
        <div className="relative grid grid-cols-[auto_1fr] items-center gap-10">
          <Device
            time={time}
            state={timeState}
            linked={s.linked}
            name={s.linked ? s.hello.name : 'maki'}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 font-mono text-[0.72rem] font-bold uppercase tracking-[0.14em]">
              <Dot on={s.linked} />
              <span className={s.linked ? 'text-green' : 'text-overlay1'}>
                {s.linked ? `linked · ${s.via}` : 'looking for maki'}
              </span>
              {s.linked && (
                <span className="text-overlay0 normal-case tracking-normal">
                  maki {s.hello.version}
                </span>
              )}
            </div>

            {s.linked ? (
              <>
                <div className="mt-5 flex items-end gap-4">
                  <span className="font-mono text-[3.4rem] leading-none font-bold tracking-[-0.04em] text-fg tabular-nums">
                    {time ?? '--:--:--'}
                  </span>
                  <span className="mb-2">
                    {timeState === TimeState.VERIFIED ? (
                      <Badge kind="built">
                        <Glyph name="check" className="h-3 w-3" /> verified
                      </Badge>
                    ) : timeState === TimeState.UNVERIFIED ? (
                      <Badge kind="warn">unverified</Badge>
                    ) : (
                      <Badge>not set</Badge>
                    )}
                  </span>
                </div>
                <p className="mt-2 text-sm text-subtext0">
                  {timeState === TimeState.VERIFIED
                    ? `maki’s clock, checked with Roughtime${verifiedBy ? ` by ${verifiedBy} servers` : ''}. Codes and the store need it.`
                    : 'maki’s clock isn’t verified yet: codes and the store wait until it is.'}
                  {drift !== null && (
                    <span className="text-overlay1">
                      {' '}
                      {drift >= 0 ? '+' : ''}
                      {drift.toFixed(1)} s from this computer.
                    </span>
                  )}
                </p>
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <Button
                    kind="primary"
                    glyph="clock"
                    disabled={link.syncing}
                    onClick={() => void link.syncNow()}
                  >
                    {link.syncing ? 'Syncing…' : 'Sync time now'}
                  </Button>
                  <Button onClick={() => link.drop('disconnected')}>Disconnect</Button>
                  <label className="ml-2 flex items-center gap-2.5 text-sm text-subtext0">
                    <Toggle
                      label="Sync when linked"
                      on={link.autoSync}
                      onChange={(on) => {
                        link.autoSync = on
                        link.note(`sync when linked: ${on ? 'on' : 'off'}`)
                      }}
                    />
                    Sync when linked
                  </label>
                </div>
              </>
            ) : (
              <>
                <p className="mt-5 max-w-md text-[0.95rem] leading-relaxed text-subtext1">
                  Plug maki in. It links by itself once you’ve allowed it here, and stays linked
                  from the tray when this window is closed.
                </p>
                <div className="mt-6 flex flex-wrap gap-2.5">
                  <Button kind="primary" glyph="usb" onClick={allow}>
                    Allow maki
                  </Button>
                  <Button onClick={connectFake}>Use fake maki</Button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="apps" go={() => go('apps')}>
          {apps.apps && apps.status === 'approved' ? (
            <>
              <div className="font-mono text-[1.7rem] font-bold tracking-[-0.03em] text-fg">
                {apps.apps.length}
                <span className="ml-1.5 text-sm font-normal text-overlay1">on maki</span>
              </div>
              <div className="mt-3">
                <StorageChart space={apps.space} apps={apps.apps} compact />
              </div>
              {apps.space && (
                <div className="mt-2 font-mono text-[0.66rem] text-overlay1">
                  {bytes(Math.max(0, apps.space.space - apps.space.taken))} free · room for{' '}
                  {apps.space.maxApps - apps.space.apps} more
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-subtext0">
              {!s.linked
                ? 'Plug maki in to see its apps.'
                : apps.status === 'locked'
                  ? 'maki is locked.'
                  : 'Asking maki…'}
            </p>
          )}
        </Stat>

        <Stat label="maki store" go={() => go('apps')}>
          {index ? (
            <>
              <div className="font-mono text-[1.7rem] font-bold tracking-[-0.03em] text-fg">
                {index.apps.length}
                <span className="ml-1.5 text-sm font-normal text-overlay1">apps</span>
              </div>
              <div className="mt-3 flex gap-1.5">
                {index.apps.slice(0, 6).map((a) => (
                  <MiniIcon key={a.id} icon={a.icon} />
                ))}
              </div>
              <div className="mt-3 font-mono text-[0.66rem] text-overlay1">
                {updates > 0 ? (
                  <span className="text-peach">
                    {updates} {updates === 1 ? 'update' : 'updates'} for maki
                  </span>
                ) : (
                  storeName
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-subtext0">
              {link.store?.problem ? 'The store can’t be reached.' : 'Checking the maki store…'}
            </p>
          )}
        </Stat>

        <Stat label="backups" go={() => go('backups')}>
          {backup ? (
            <>
              <div className="font-mono text-[1.7rem] font-bold tracking-[-0.03em] text-fg">
                {ago(backup.at)}
              </div>
              <p className="mt-2 text-sm text-subtext0">
                The last backup: {bytes(backup.bytes)}, encrypted. Only maki’s recovery phrase opens
                it.
              </p>
            </>
          ) : (
            <p className="text-sm text-subtext0">
              No backup yet. maki desktop makes one when maki links, and after each login it saves.
            </p>
          )}
        </Stat>
      </div>
    </div>
  )
}

/** A store app's icon, small, for a row of them. */
function MiniIcon({ icon }: { icon: Uint32Array | null }): React.JSX.Element {
  return icon ? (
    <PixelTile icon={icon} />
  ) : (
    <div className="h-8 w-8 rounded-[22%] bg-oled">
      <MakiMark className="h-8 w-8 opacity-40" />
    </div>
  )
}

function PixelTile({ icon }: { icon: Uint32Array }): React.JSX.Element {
  return (
    <canvas
      width={64}
      height={64}
      className="h-8 w-8 rounded-[22%] border border-surface1/70 bg-oled"
      style={{ imageRendering: 'pixelated' }}
      ref={(c) => {
        const ctx = c?.getContext('2d')
        if (!ctx) return
        const image = ctx.createImageData(64, 64)
        iconPixels(icon).forEach((light, i) =>
          image.data.set(light ? [243, 239, 230, 255] : [10, 10, 16, 255], i * 4)
        )
        ctx.putImageData(image, 0, 0)
      }}
    />
  )
}
