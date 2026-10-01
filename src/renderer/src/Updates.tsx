import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import { buildLabel, firmwareState, newer, releaseLabel } from '@shared/releases'
import { Badge, Button, Card, Glyph, Label } from './ui'
import {
  firmwareUpdate,
  updateDesktop,
  useFirmwareUpdate,
  type FirmwareStage
} from './updates-state'

/**
 * Updates for maki's firmware and for maki desktop itself, from the releases the maki store
 * signs (its index), and how many of maki's apps the store has newer versions of.
 */
export function Updates({
  link,
  appUpdates,
  goApps
}: {
  link: Link
  appUpdates: number
  goApps: () => void
}): React.JSX.Element {
  const releases = link.store?.index?.releases
  const s = link.state
  const stage = useFirmwareUpdate()
  const [info, setInfo] = useState<{
    version: string
    platform: string
    appImage: boolean
    firmwareHere: boolean
  } | null>(null)
  const [desktopBusy, setDesktopBusy] = useState<string | null>(null)
  useEffect(() => void window.maki.updates.info().then(setInfo), [])

  const fw = releases?.firmware ?? null
  const fwState = s.linked && fw ? firmwareState(s.hello.version, fw) : null
  const desktop = releases?.desktop ?? null
  const desktopFile = desktop?.files.find((f) => f.platform === info?.platform) ?? null
  const desktopNewer = !!(desktop && info && newer(info.version, desktop.name))

  const updateSelf = async (): Promise<void> => {
    if (!desktop || !desktopFile) return
    setDesktopBusy('Fetching the new maki desktop…')
    try {
      await updateDesktop(desktopFile, desktop.name)
      setDesktopBusy('Restarting…')
    } catch (e) {
      setDesktopBusy(null)
      link.note(`maki desktop’s update: ${(e as Error).message}`)
    }
  }

  return (
    <Card className="space-y-4">
      <Label>updates</Label>

      <Row
        title="maki’s firmware"
        now={s.linked ? buildLabel(s.hello.version) : null}
        state={
          !s.linked ? (
            <span className="text-overlay1">Plug maki in to see its firmware.</span>
          ) : !fw ? (
            <span className="text-overlay1">The maki store lists no firmware yet.</span>
          ) : fwState === 'current' ? (
            <Badge kind="built">
              <Glyph name="check" className="h-3 w-3" /> up to date
            </Badge>
          ) : fwState === 'ahead' ? (
            <span className="text-overlay1">
              Built after {releaseLabel(fw.name)}, the newest release: a developer’s.
            </span>
          ) : (
            <span className="text-subtext0">
              <Badge kind="next">{releaseLabel(fw.name)}</Badge>{' '}
              {fwState === 'unknown' ? 'is the newest release' : 'is out'}
              {fw.notes && (
                <a
                  className="ml-2 text-peach hover:underline"
                  href={fw.notes}
                  target="_blank"
                  rel="noreferrer"
                >
                  what’s new
                </a>
              )}
            </span>
          )
        }
        action={
          s.linked &&
          fw &&
          (fwState === 'update' || fwState === 'unknown') &&
          stage.stage === 'idle' &&
          info?.firmwareHere ? (
            <Button
              kind={fwState === 'update' ? 'primary' : 'quiet'}
              glyph="download"
              onClick={() => void firmwareUpdate.run(link, fw)}
            >
              Update maki
            </Button>
          ) : null
        }
      />
      {stage.stage !== 'idle' && <FirmwareProgress stage={stage} link={link} />}

      <Row
        title="maki desktop"
        now={info?.version ?? null}
        state={
          !desktop ? (
            <span className="text-overlay1">The maki store lists no maki desktop yet.</span>
          ) : desktopNewer ? (
            <span className="text-subtext0">
              <Badge kind="next">{desktop.name}</Badge> is out
              {desktop.notes && (
                <a
                  className="ml-2 text-peach hover:underline"
                  href={desktop.notes}
                  target="_blank"
                  rel="noreferrer"
                >
                  what’s new
                </a>
              )}
            </span>
          ) : (
            <Badge kind="built">
              <Glyph name="check" className="h-3 w-3" /> up to date
            </Badge>
          )
        }
        action={
          desktopNewer ? (
            desktopBusy ? (
              <span className="font-mono text-[0.72rem] text-overlay1">{desktopBusy}</span>
            ) : info?.appImage && desktopFile ? (
              <Button kind="primary" glyph="download" onClick={() => void updateSelf()}>
                Update and restart
              </Button>
            ) : (
              <a
                className="font-mono text-[0.72rem] text-peach hover:underline"
                href="https://maki.netslum.io/download/"
                target="_blank"
                rel="noreferrer"
              >
                get it from maki.netslum.io
              </a>
            )
          ) : null
        }
      />

      <Row
        title="maki’s apps"
        now={null}
        state={
          appUpdates > 0 ? (
            <span className="text-subtext0">
              <Badge kind="next">
                {appUpdates} {appUpdates === 1 ? 'update' : 'updates'}
              </Badge>{' '}
              in the maki store
            </span>
          ) : (
            <span className="text-overlay1">Each app updates from the maki store, on Apps.</span>
          )
        }
        action={appUpdates > 0 ? <Button onClick={goApps}>See them</Button> : null}
      />
    </Card>
  )
}

function Row({
  title,
  now,
  state,
  action
}: {
  title: string
  now: string | null
  state: React.ReactNode
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 border-t border-surface0 pt-4 first-of-type:border-0 first-of-type:pt-0">
      <div className="w-40 shrink-0">
        <div className="text-sm font-semibold text-fg">{title}</div>
        {now && <div className="mt-0.5 truncate font-mono text-[0.68rem] text-overlay1">{now}</div>}
      </div>
      <div className="min-w-0 flex-1 text-sm">{state}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/** Where a firmware update is, in words, with what to do when it needs a hand. */
function FirmwareProgress({
  stage,
  link
}: {
  stage: FirmwareStage
  link: Link
}): React.JSX.Element {
  const line = ((): React.ReactNode => {
    switch (stage.stage) {
      case 'fetching':
        return `Fetching the new firmware… ${stage.of ? Math.floor((stage.done * 100) / stage.of) : 0}%`
      case 'asking':
        return 'Say yes on maki: it asks to restart for the update.'
      case 'by hand':
        return (
          <>
            This maki’s firmware can’t restart for an update by itself. Unplug maki, then plug it
            back in holding one of its buttons, until its screen says it’s in update mode.
            <Button
              small
              kind="primary"
              className="ml-3"
              onClick={() => void firmwareUpdate.install(link)}
            >
              It’s in update mode
            </Button>
          </>
        )
      case 'restarting':
        return 'maki is restarting into update mode…'
      case 'copying':
        return `Putting ${stage.file} on maki…`
      case 'booting':
        return 'Starting the new firmware…'
      case 'linking':
        return 'maki is starting up. It links again in a moment: then enter your PIN on it.'
      case 'done':
        return `maki runs ${stage.label} now.`
      case 'failed':
        return (
          <>
            <span className="text-red">{stage.why}</span>
            <Button small className="ml-3" onClick={() => firmwareUpdate.reset()}>
              Close
            </Button>
          </>
        )
      default:
        return null
    }
  })()
  return (
    <div className="rounded-lg border border-surface1 bg-surface0/40 px-4 py-3 font-mono text-[0.74rem] text-subtext1">
      {line}
      {stage.stage === 'done' && (
        <Button small className="ml-3" onClick={() => firmwareUpdate.reset()}>
          Close
        </Button>
      )}
    </div>
  )
}
