import { app } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Start at login, in the tray. macOS and Windows have login items; Linux desktops read
 * ~/.config/autostart, which Electron doesn't manage, so we write the entry ourselves.
 */

const autostartFile = join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'autostart', 'maki.desktop')

function command(): string {
  // an AppImage runs from a temporary mount; APPIMAGE is the file the user actually has
  const exe = process.env['APPIMAGE'] ?? process.execPath
  const quoted = `"${exe}"`
  return app.isPackaged ? `${quoted} --hidden` : `${quoted} "${app.getAppPath()}" --hidden`
}

export async function getStartAtLogin(): Promise<boolean> {
  if (process.platform !== 'linux') return app.getLoginItemSettings().openAtLogin
  return readFile(autostartFile, 'utf8').then(
    (text) => text.includes('Exec='),
    () => false
  )
}

export async function setStartAtLogin(on: boolean): Promise<void> {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
    return
  }
  if (!on) {
    await rm(autostartFile, { force: true })
    return
  }
  await mkdir(join(autostartFile, '..'), { recursive: true })
  await writeFile(
    autostartFile,
    ['[Desktop Entry]', 'Type=Application', 'Name=maki', 'Comment=The link between this computer and maki', `Exec=${command()}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n')
  )
}
