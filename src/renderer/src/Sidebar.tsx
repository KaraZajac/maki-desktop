import type { Link } from '@shared/link'
import type { Page } from './Overview'
import { Dot, Glyph, MakiMark } from './ui'

export const PAGES: { id: Page; title: string; glyph: string }[] = [
  { id: 'overview', title: 'Overview', glyph: 'overview' },
  { id: 'apps', title: 'Apps', glyph: 'apps' },
  { id: 'wallets', title: 'Wallets', glyph: 'wallet' },
  { id: 'connections', title: 'Connections', glyph: 'plug' },
  { id: 'backups', title: 'Backups', glyph: 'shield' }
]

export function Sidebar({
  link,
  page,
  go,
  updates
}: {
  link: Link
  page: Page
  go: (page: Page) => void
  /** store apps newer than maki has */
  updates: number
}): React.JSX.Element {
  const s = link.state
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-surface0 bg-mantle/85">
      <div className="flex items-center gap-3 px-5 pt-6 pb-6">
        <MakiMark className="h-10 w-10 drop-shadow-[0_0_16px_rgba(255,122,89,0.35)]" />
        <div>
          <div className="font-mono text-[1.35rem] leading-none font-bold tracking-[-0.035em] text-fg">
            maki
          </div>
          <div className="mt-1 font-mono text-[0.6rem] tracking-[0.24em] text-overlay1 uppercase">
            desktop
          </div>
        </div>
      </div>

      <div className="mx-4 mb-5 rounded-xl border border-surface0 bg-crust/50 px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <Dot on={s.linked} />
          <span
            className={`font-mono text-[0.72rem] font-bold ${s.linked ? 'text-green' : 'text-subtext0'}`}
          >
            {s.linked ? s.hello.name : 'looking for maki…'}
          </span>
        </div>
        <div className="mt-1 truncate pl-[1.1rem] font-mono text-[0.64rem] text-overlay1">
          {s.linked ? `maki ${s.hello.version} · ${s.via}` : 'plug it in'}
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-3">
        {PAGES.map((p) => {
          const here = p.id === page
          return (
            <button
              key={p.id}
              onClick={() => go(p.id)}
              className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[0.9rem] transition-colors ${
                here ? 'bg-peach/10 text-peach' : 'text-subtext0 hover:bg-surface0/50 hover:text-fg'
              }`}
            >
              {here && (
                <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-peach" />
              )}
              <Glyph name={p.glyph} className="h-[1.1rem] w-[1.1rem]" />
              <span className="flex-1 text-left font-medium">{p.title}</span>
              {p.id === 'apps' && updates > 0 && (
                <span className="rounded-full bg-peach px-1.5 font-mono text-[0.62rem] font-bold text-crust">
                  {updates}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto px-5 pb-5 font-mono text-[0.62rem] leading-relaxed text-overlay0">
        <div>maki desktop 0.1.0</div>
        <div>BSD-3-Clause · .leviathan</div>
      </div>
    </aside>
  )
}
