import type { Link } from '@shared/link'
import { ago, Button, bytes, Card, Glyph, Label, PageHeader } from './ui'

/** maki's backups: encrypted on maki, kept on this computer, restored to a maki with the same phrase. */
export function Backups({
  link,
  backup
}: {
  link: Link
  backup: { at: number; bytes: number } | null
}): React.JSX.Element {
  const linked = link.state.linked
  return (
    <div className="rise space-y-6">
      <PageHeader
        label="backups"
        title="Backups"
        lede="maki’s logins, codes, passkeys and apps’ data, encrypted on maki with a key only its recovery phrase gives: safe to keep anywhere, and useless to anyone without the phrase."
      />
      <Card>
        <div className="flex items-start gap-5">
          <div className="rounded-xl border border-surface1 bg-crust p-3 text-green">
            <Glyph name="shield" className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <Label>the latest</Label>
            {backup ? (
              <>
                <div className="mt-3 font-mono text-[1.9rem] leading-none font-bold tracking-[-0.03em] text-fg">
                  {ago(backup.at)}
                </div>
                <p className="mt-2 text-sm text-subtext0">
                  {new Date(backup.at).toLocaleString()} · {bytes(backup.bytes)}, encrypted
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-subtext1">No backup yet.</p>
            )}
            <p className="mt-3 text-xs text-overlay1">
              maki desktop backs maki up as it links, and after each login maki saves.
            </p>
            <div className="mt-5 flex flex-wrap gap-2.5">
              <Button
                kind="primary"
                glyph="shield"
                disabled={!linked || link.backingUp}
                onClick={() => void link.backupNow()}
              >
                {link.backingUp ? 'Backing up…' : 'Back up now'}
              </Button>
              <Button disabled={!linked || !backup} onClick={() => void link.restoreLatest()}>
                Restore to maki
              </Button>
              <Button glyph="file" onClick={() => void window.maki.backups.show()}>
                Show folder
              </Button>
            </div>
          </div>
        </div>
      </Card>
      <Card>
        <Label>restoring</Label>
        <p className="mt-3 text-sm leading-relaxed text-subtext1">
          On a new or wiped maki: set a PIN, enter the recovery phrase on maki, link it, and
          restore. maki adds what it doesn’t have, and asks you first. A backup another phrase made
          is refused: it can’t be opened without its own.
        </p>
      </Card>
    </div>
  )
}
