import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installScript, refreshScripts, scriptPath, type Command } from './scripts'

const saved = process.env.HOME
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'maki-home-'))
  process.env.HOME = home
})
afterEach(() => {
  process.env.HOME = saved
  rmSync(home, { recursive: true, force: true })
})

const SIGN: Command = { name: 'maki-sign-test', flag: '--sign-test', why: 'a test signs with maki' }
const OTHER: Command = { name: 'maki-other-test', flag: '--other-test', why: 'another' }

describe.skipIf(process.platform === 'win32')('commands on the PATH', () => {
  it('follow the AppImage an update put in place', async () => {
    const old = { exe: '/home/k/maki-0.1.1.AppImage', appPath: null }
    const now = { exe: '/home/k/maki-0.1.2.AppImage', appPath: null }
    await installScript(SIGN, old)
    await refreshScripts([SIGN, OTHER], now)
    const text = readFileSync(scriptPath(SIGN.name), 'utf8')
    expect(text).toContain(
      `exec '/home/k/maki-0.1.2.AppImage' --ozone-platform=headless --sign-test`
    )
    expect(statSync(scriptPath(SIGN.name)).mode & 0o777).toBe(0o755)
    // one that was never put here isn't made
    expect(() => statSync(scriptPath(OTHER.name))).toThrow()
  })

  it('leave someone’s own script of the same name alone', async () => {
    mkdirSync(dirname(scriptPath(SIGN.name)), { recursive: true })
    writeFileSync(scriptPath(SIGN.name), '#!/bin/sh\necho mine\n')
    await refreshScripts([SIGN], { exe: '/home/k/maki.AppImage', appPath: null })
    expect(readFileSync(scriptPath(SIGN.name), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })
})
