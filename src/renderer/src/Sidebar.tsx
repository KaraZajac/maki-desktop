import type { Link } from '@shared/link'
import { ABOUT, SECTIONS, shown, type Page, type PageInfo } from './pages'
import { Dot, Glyph, MakiMark } from './ui'

export function Sidebar({
  link,
  page,
  go,
  updates,
  known
}: {
  link: Link
  page: Page
  go: (page: Page) => void
  /** store apps newer than maki has */
  updates: number
  /** the apps maki has, or had when last linked: their pages show */
  known: string[]
}): React.JSX.Element {
  const s = link.state
  const item = (p: PageInfo): React.JSX.Element => {
    const here = p.id === page
    return (
      <button
        key={p.id}
        onClick={() => go(p.id)}
        aria-current={here ? 'page' : undefined}
        className={`group relative flex items-center gap-3 rounded-lg px-3 py-[0.4rem] text-[0.86rem] transition-colors ${
          here ? 'bg-peach/10 text-peach' : 'text-subtext0 hover:bg-surface0/50 hover:text-fg'
        }`}
      >
        {here && (
          <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-peach" />
        )}
        <Glyph name={p.glyph} className="h-[1.05rem] w-[1.05rem]" />
        <span className="flex-1 text-left font-medium">{p.title}</span>
        {p.id === 'apps' && updates > 0 && (
          <span className="rounded-full bg-peach px-1.5 font-mono text-[0.62rem] font-bold text-crust">
            {updates}
          </span>
        )}
      </button>
    )
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-surface0 bg-mantle/85">
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
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

      <div className="mx-4 mb-3 rounded-xl border border-surface0 bg-crust/50 px-3.5 py-2.5">
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

      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        {SECTIONS.map((section) => {
          const pages = section.pages.filter((p) => shown(p, known))
          if (pages.length === 0) return null
          return (
            <div key={section.title ?? 'maki'} className="flex flex-col gap-0.5">
              {section.title && (
                <div className="mt-3 mb-0.5 px-3 font-mono text-[0.6rem] tracking-[0.2em] text-overlay0 uppercase">
                  {section.title}
                </div>
              )}
              {pages.map(item)}
            </div>
          )
        })}
      </nav>

      <div className="border-t border-surface0 px-3 pt-1.5 pb-3">{item(ABOUT)}</div>
    </aside>
  )
}
