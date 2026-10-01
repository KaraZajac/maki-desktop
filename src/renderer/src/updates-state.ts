import { useEffect, useState } from 'react'
import { MakiError } from '@shared/client'
import type { Link } from '@shared/link'
import { buildLabel, firmwareState, type Release, type ReleaseFile } from '@shared/releases'

/**
 * A firmware update as it goes: maki desktop fetches the release (checked against the store's
 * record), asks maki to restart into update mode (its owner says yes on maki), puts the files on
 * its update drive, starts the new firmware, and waits for maki to link again running it. It
 * lives outside the pages, so it carries on while another one is shown.
 */
export type FirmwareStage =
  | { stage: 'idle' }
  | { stage: 'fetching'; done: number; of: number }
  | { stage: 'asking' }
  /** maki's firmware doesn't restart for updates by itself: the owner puts it in update mode */
  | { stage: 'by hand' }
  | { stage: 'restarting' }
  | { stage: 'copying'; file: string }
  | { stage: 'booting' }
  | { stage: 'linking' }
  | { stage: 'done'; label: string }
  | { stage: 'failed'; why: string }

/** How long maki has to link again after the new firmware starts: it boots in about 20 s. */
const RELINK_MS = 180_000

class FirmwareUpdate {
  now: FirmwareStage = { stage: 'idle' }
  private listeners = new Set<() => void>()
  private paths: Record<string, string> | null = null
  private release: Release | null = null

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private set(s: FirmwareStage): void {
    this.now = s
    for (const l of this.listeners) l()
  }

  get busy(): boolean {
    return !['idle', 'done', 'failed', 'by hand'].includes(this.now.stage)
  }

  /** The whole update, from fetching the files to maki linking again with the new firmware. */
  async run(link: Link, release: Release): Promise<void> {
    if (this.busy) return
    this.release = release
    try {
      const of = release.files.reduce((n, f) => n + f.bytes, 0)
      const got: Record<string, number> = {}
      this.set({ stage: 'fetching', done: 0, of })
      const off = window.maki.updates.onProgress((p) => {
        got[p.name] = p.bytes
        this.set({ stage: 'fetching', done: Object.values(got).reduce((a, b) => a + b, 0), of })
      })
      try {
        this.paths = await window.maki.updates.fetch(release.name, release.files)
      } finally {
        off()
      }
      this.set({ stage: 'asking' })
      let approval: string
      try {
        approval = await link.updateMode(release.name)
      } catch (e) {
        // firmware from before UPDATE_MODE: its owner puts maki in update mode by hand
        if (e instanceof MakiError && e.code === 2) return this.set({ stage: 'by hand' })
        throw e
      }
      if (approval !== 'approved') {
        return this.set({
          stage: 'failed',
          why:
            approval === 'locked'
              ? 'maki is locked: enter its PIN, then update again'
              : approval === 'denied'
                ? 'Cancelled on maki'
                : approval === 'timed out'
                  ? 'Nobody said yes on maki in time'
                  : `maki couldn’t restart for the update (${approval})`
        })
      }
      await this.install(link)
    } catch (e) {
      this.set({ stage: 'failed', why: (e as Error).message })
    }
  }

  /** On from maki being in update mode: put the files on it, start them, wait for the link. */
  async install(link: Link): Promise<void> {
    const release = this.release
    if (!this.paths || !release) return
    try {
      this.set({ stage: 'restarting' })
      const off = window.maki.updates.onFirmwareStep(({ step, detail }) => {
        if (step === 'copying' && detail) this.set({ stage: 'copying', file: detail })
        else if (step === 'booting') this.set({ stage: 'booting' })
      })
      try {
        await window.maki.updates.installFirmware(this.paths)
      } finally {
        off()
      }
      this.set({ stage: 'linking' })
      const started = Date.now()
      // maki links again by itself (usb.ts) once the new firmware is up
      while (Date.now() - started < RELINK_MS) {
        const s = link.state
        if (s.linked && firmwareState(s.hello.version, release) === 'current') {
          return this.set({ stage: 'done', label: buildLabel(s.hello.version) })
        }
        await new Promise((ok) => setTimeout(ok, 1000))
      }
      const s = link.state
      this.set(
        s.linked
          ? { stage: 'failed', why: `maki came back running ${buildLabel(s.hello.version)}` }
          : { stage: 'failed', why: 'maki hasn’t linked again: unplug it and plug it back in' }
      )
    } catch (e) {
      this.set({ stage: 'failed', why: (e as Error).message })
    }
  }

  reset(): void {
    if (!this.busy) this.set({ stage: 'idle' })
  }
}

export const firmwareUpdate = new FirmwareUpdate()

export function useFirmwareUpdate(): FirmwareStage {
  const [, tick] = useState(0)
  useEffect(() => firmwareUpdate.subscribe(() => tick((n) => n + 1)), [])
  return firmwareUpdate.now
}

/** maki desktop's own update: fetch the new AppImage, put it in place of this one, restart. */
export async function updateDesktop(file: ReleaseFile, version: string): Promise<void> {
  await window.maki.updates.replaceDesktop(file, version)
}
