import { useState } from 'react'
import type { Link } from '@shared/link'
import { Glyph } from './ui'

/** What maki desktop has been doing: the newest line, and all of them on request. */
export function Activity({ link }: { link: Link }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const log = link.log
  return (
    <div className="border-t border-surface0 bg-mantle/80">
      {open && (
        <div className="selectable max-h-52 overflow-y-auto px-6 pt-3 pb-1 font-mono text-[0.7rem] leading-relaxed text-subtext0">
          {log.length === 0 ? 'Nothing yet.' : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-6 py-2 text-left font-mono text-[0.7rem] text-overlay1 hover:text-subtext0"
      >
        <Glyph name="activity" className="h-3.5 w-3.5 text-overlay0" />
        <span className="min-w-0 flex-1 truncate">
          {open ? 'Activity' : (log[0] ?? 'Waiting for maki.')}
        </span>
        <Glyph name={open ? 'down' : 'up'} className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
