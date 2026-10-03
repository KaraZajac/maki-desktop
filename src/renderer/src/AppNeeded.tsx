import type { ReactNode } from 'react'
import type { Link } from '@shared/link'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Button, Card, Glyph } from './ui'

/**
 * What one of maki's apps' pages shows while it can't do what it's for: maki away, maki locked (its
 * apps aren't known until its PIN is in), or maki without the app, with a way to the Apps page to
 * get it. Null once maki is linked and has the app. `glyph` is the page's, `pitch` what the app
 * does, in a sentence or two, for the page to say while maki hasn't it.
 */
export function AppNeeded({
  link,
  apps,
  id,
  name,
  glyph,
  pitch,
  go
}: {
  link: Link
  apps: Apps
  id: string
  name: string
  glyph: string
  pitch: ReactNode
  go: (page: Page) => void
}): React.JSX.Element | null {
  const linked = link.state.linked
  if (linked && apps.status === 'approved' && apps.apps?.some((a) => a.id === id)) return null
  const [title, says, action] = !linked
    ? [
        'maki isn’t here',
        <>Plug maki in and unlock it: this page works with maki’s {name} app, over the link.</>,
        null
      ]
    : apps.status === 'locked'
      ? [
          'maki is locked',
          <>
            Put maki’s PIN in on maki: its apps, {name} among them, show here once it’s unlocked.
          </>,
          null
        ]
      : apps.status !== 'approved'
        ? [
            'Asking maki',
            <>
              maki desktop is asking maki which apps it has{apps.status ? ` (${apps.status})` : ''}.
            </>,
            null
          ]
        : [
            `${name} isn’t on maki`,
            pitch,
            <Button key="get" kind="ghost" glyph="apps" onClick={() => go('apps')}>
              Get it on Apps
            </Button>
          ]
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-5">
        <div className="rounded-xl border border-surface1 bg-crust p-3 text-peach">
          <Glyph name={glyph} className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-bold text-fg">{title}</div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-subtext1">{says}</p>
        </div>
        {action}
      </div>
    </Card>
  )
}

/**
 * A card's way to an app maki hasn't: the Apps page, once maki is linked and unlocked and has said
 * what it has. While maki is away or locked (which is why its apps aren't known), it says that
 * instead of offering what maki may well have.
 */
export function GetIt({ apps, go }: { apps: Apps; go: (page: Page) => void }): React.JSX.Element {
  if (apps.status === 'approved')
    return (
      <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
        Get it
      </Button>
    )
  return (
    <span className="shrink-0 font-mono text-[0.68rem] text-overlay1">
      {apps.status === 'locked' ? 'maki is locked' : 'maki isn’t here'}
    </span>
  )
}
