import { describe, expect, it } from 'vitest'
import {
  buildLabel,
  firmwareState,
  newer,
  parseBuild,
  parseReleases,
  platformName,
  type Release
} from './releases'

const SHA = 'a'.repeat(64)
const COMMIT = '86a1f5ba4c9b0a1e2f3d4c5b6a7980716253443a'

const fileOf = (name: string, extra: object = {}): object => ({
  name,
  url: `https://github.com/KaraZajac/maki-firmware/releases/download/preview-2026-10-01/${name}`,
  bytes: 1000,
  sha256: SHA,
  ...extra
})

const firmware = (files = ['loader.uf2', 'xous.uf2', 'swap.uf2']): object => ({
  name: 'preview-2026-10-01',
  commit: COMMIT,
  date: '2026-10-01',
  notes: 'https://github.com/KaraZajac/maki-firmware/releases/tag/preview-2026-10-01',
  files: files.map((f) => fileOf(f))
})

describe('the store’s releases', () => {
  it('reads the firmware and maki desktop as the store signed them', () => {
    const r = parseReleases({
      firmware: firmware(),
      desktop: {
        name: '0.1.3',
        commit: COMMIT,
        date: '2026-10-01',
        files: [fileOf('maki-desktop-0.1.3-x86_64.AppImage', { platform: 'linux-x86_64' })]
      }
    })
    expect(r.firmware?.name).toBe('preview-2026-10-01')
    expect(r.firmware?.files.map((f) => f.name)).toEqual(['loader.uf2', 'xous.uf2', 'swap.uf2'])
    expect(r.desktop?.files[0].platform).toBe('linux-x86_64')
    expect(r.desktop?.notes).toBeNull()
  })

  it('leaves out a release that isn’t right, rather than trust any of it', () => {
    expect(parseReleases(undefined)).toEqual({ firmware: null, desktop: null })
    expect(parseReleases({ firmware: firmware(['loader.uf2', 'xous.uf2']) }).firmware).toBeNull()
    const bad = (change: object): Release | null =>
      parseReleases({ firmware: { ...firmware(), ...change } }).firmware
    expect(bad({ commit: '86a1f5ba4' })).toBeNull()
    expect(bad({ date: 'today' })).toBeNull()
    expect(bad({ notes: 'http://example.com' })).toBeNull()
    expect(bad({ name: '../x' })).toBeNull()
    const files = (f: object): Release | null =>
      bad({ files: [fileOf('loader.uf2'), fileOf('xous.uf2'), { ...fileOf('swap.uf2'), ...f }] })
    expect(files({ url: 'http://example.com/swap.uf2' })).toBeNull()
    expect(files({ sha256: 'A'.repeat(64) })).toBeNull()
    expect(files({ bytes: 0 })).toBeNull()
    expect(files({ bytes: 600 * 1024 * 1024 })).toBeNull()
    expect(files({})).not.toBeNull()
  })
})

describe('maki’s firmware build', () => {
  it('reads the build maki names in HELLO', () => {
    expect(parseBuild('preview-2026-09-29-46-g86a1f5ba4')).toEqual({
      tag: 'preview-2026-09-29',
      ahead: 46,
      commit: '86a1f5ba4'
    })
    expect(parseBuild('0.1.0')).toBeNull()
    expect(buildLabel('preview-2026-10-01-0-g86a1f5ba4')).toBe('preview 2026-10-01')
    expect(buildLabel('preview-2026-09-29-46-g86a1f5ba4')).toBe(
      'preview 2026-09-29 + 46 · 86a1f5ba4'
    )
    expect(buildLabel('0.1.0')).toBe('0.1.0')
  })

  it('says whether there is newer firmware', () => {
    const newest = parseReleases({ firmware: firmware() }).firmware!
    expect(firmwareState('preview-2026-10-01-0-g86a1f5ba4', newest)).toBe('current')
    expect(firmwareState('preview-2026-09-29-46-g705127d6a', newest)).toBe('update')
    // before builds were named, maki said its link's version
    expect(firmwareState('0.1.0', newest)).toBe('update')
    // built after the release: a developer's
    expect(firmwareState('preview-2026-10-01-3-g1f2e3d4c5', newest)).toBe('ahead')
    expect(firmwareState('v0.10.2-12-g1f2e3d4c5', newest)).toBe('unknown')
  })

  it('places a second release the same day after the first', () => {
    const second = parseReleases({
      firmware: { ...firmware(), name: 'preview-2026-10-01.2', commit: 'c'.repeat(40) }
    }).firmware!
    expect(firmwareState('preview-2026-10-01-0-g86a1f5ba4', second)).toBe('update')
    expect(firmwareState('preview-2026-09-29-46-g705127d6a', second)).toBe('update')
    expect(firmwareState(`preview-2026-10-01.2-0-g${'c'.repeat(9)}`, second)).toBe('current')
    expect(firmwareState('preview-2026-10-01.2-4-g1f2e3d4c5', second)).toBe('ahead')
    // and the first comes before a third
    const third = parseReleases({
      firmware: { ...firmware(), name: 'preview-2026-10-01.3', commit: 'd'.repeat(40) }
    }).firmware!
    expect(firmwareState('preview-2026-10-01.2-0-g1f2e3d4c5', third)).toBe('update')
    expect(buildLabel('preview-2026-10-01.2-0-g1f2e3d4c5')).toBe('preview 2026-10-01.2')
  })
})

describe('maki desktop’s version', () => {
  it('compares versions part by part', () => {
    expect(newer('0.1.2', '0.1.3')).toBe(true)
    expect(newer('0.1.9', '0.1.10')).toBe(true)
    expect(newer('0.1.3', '0.1.3')).toBe(false)
    expect(newer('0.2.0', '0.1.9')).toBe(false)
    expect(newer('0.1', '0.1.1')).toBe(true)
  })

  it('names the platform as releases do', () => {
    expect(platformName('linux', 'x64')).toBe('linux-x86_64')
    expect(platformName('darwin', 'arm64')).toBe('macos-aarch64')
  })
})
