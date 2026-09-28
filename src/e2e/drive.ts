/**
 * Driving the real app for end-to-end tests: built once, run offscreen with scripts/screenshot.cjs
 * against the fake maki, its settings and sockets in a folder of the test's own. Node only.
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const DESKTOP = resolve(__dirname, '../..')
const ELECTRON = join(DESKTOP, 'node_modules/electron/dist/electron')

/** Whether to run them: MAKI_E2E=1 (they need a display, and take a while). */
export const E2E = process.env.MAKI_E2E === '1'

/**
 * The app as `npm run build` makes it. Test files run side by side, each in a process of its own:
 * one builds while the others wait, and a build that finished moments ago isn't done again.
 */
export function build(): void {
  const lock = join(tmpdir(), 'maki-e2e-build.lock')
  const stamp = join(DESKTOP, 'out', '.e2e-built')
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      // another test file is building; one that died holding the lock is gone a while
      try {
        if (Date.now() - statSync(lock).mtimeMs > 300_000)
          rmSync(lock, { recursive: true, force: true })
      } catch {
        // gone already
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
  try {
    const fresh = (() => {
      try {
        return Date.now() - statSync(stamp).mtimeMs < 60_000
      } catch {
        return false
      }
    })()
    if (!fresh) {
      execFileSync('npm', ['run', '-s', 'build'], { cwd: DESKTOP, stdio: 'ignore' })
      writeFileSync(stamp, '')
    }
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * The app, linked to the fake maki on `fakePort`, clicked through `steps` (screenshot.cjs's); what
 * its page said at the end. `home` holds what it keeps; `env` adds to its environment.
 */
export function drive(
  home: string,
  fakePort: number,
  steps: string[],
  env: Record<string, string> = {}
): Promise<string> {
  const page = join(home, 'page.png')
  const text = join(home, 'page.txt')
  const wayland = process.env.WAYLAND_DISPLAY
  return new Promise((ok, fail) =>
    execFile(
      ELECTRON,
      [
        join(DESKTOP, 'scripts/screenshot.cjs'),
        page,
        '--fake',
        '--size',
        '1080x1600',
        ...steps,
        '--dump',
        text
      ],
      {
        cwd: DESKTOP,
        env: {
          ...process.env,
          // its settings, sockets and anything else it keeps, in here
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_RUNTIME_DIR: home,
          // the display, wherever it was: its name alone is relative to the runtime directory
          ...(wayland && !wayland.startsWith('/') && process.env.XDG_RUNTIME_DIR
            ? { WAYLAND_DISPLAY: join(process.env.XDG_RUNTIME_DIR, wayland) }
            : {}),
          MAKI_FAKE_PORT: String(fakePort),
          ...env
        },
        timeout: 170_000
      },
      (e, _out, err) => {
        let said = ''
        try {
          said = readFileSync(text, 'utf8')
        } catch {
          // nothing to read: it didn't get that far
        }
        if (e) fail(new Error(`${err}\n--- the page said:\n${said}`))
        else ok(said)
      }
    )
  )
}
