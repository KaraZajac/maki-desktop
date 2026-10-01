/**
 * Commands maki desktop puts on the PATH: each a small script that starts this app in a mode of
 * its own (a flag), which does its work through the tray app's socket and the link, asking an
 * app on maki. age-plugin-maki (age runs it), maki-minisign, and git's maki-ssh-keygen.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { CommandStatus } from '../shared/commands'
import type { Launch } from './browsers'

export type ScriptStatus = CommandStatus

/** A command on this computer: its name, the flag that starts this app for it, and why it's there. */
export interface Command {
  name: string
  flag: string
  why: string
}

/** Where it goes: ~/.local/bin (on Windows, a .cmd in maki's folder, which PATH needs). */
export function scriptPath(name: string): string {
  if (process.platform === 'win32') {
    return join(
      process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'),
      'maki',
      `${name}.cmd`
    )
  }
  return join(homedir(), '.local', 'bin', name)
}

export function scriptText(c: Command, { exe, appPath }: Launch): string {
  if (process.platform === 'win32') {
    const q = (s: string): string => `"${s.replace(/%/g, '%%')}"`
    const target = appPath ? `${q(exe)} ${q(appPath)}` : q(exe)
    return `@echo off\r\nrem written by maki desktop: ${c.why}\r\n${target} ${c.flag} %*\r\n`
  }
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const target = appPath ? `${q(exe)} ${q(appPath)}` : q(exe)
  return `#!/bin/sh\n# written by maki desktop: ${c.why}\nexec ${target} --ozone-platform=headless ${c.flag} "$@"\n`
}

export async function scriptStatus(c: Command, launch: Launch): Promise<ScriptStatus> {
  const path = scriptPath(c.name)
  const installed = await readFile(path, 'utf8').then(
    (text) => text === scriptText(c, launch),
    () => false
  )
  const folders = (process.env['PATH'] ?? '').split(delimiter)
  return { installed, path, onPath: folders.includes(dirname(path)) }
}

/**
 * At start: each command maki desktop put here that starts another file (an AppImage an update
 * replaced, or one since moved) is written again for this one, so git's signing, age and
 * minisign go on working after an update. Someone's own script of the same name is left alone.
 */
export async function refreshScripts(commands: Command[], launch: Launch): Promise<void> {
  for (const c of commands) {
    const path = scriptPath(c.name)
    const text = await readFile(path, 'utf8').catch(() => null)
    if (
      text === null ||
      text === scriptText(c, launch) ||
      !text.includes('written by maki desktop')
    )
      continue
    await writeFile(path, scriptText(c, launch))
    await chmod(path, 0o755)
  }
}

export async function installScript(c: Command, launch: Launch): Promise<ScriptStatus> {
  const path = scriptPath(c.name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, scriptText(c, launch))
  await chmod(path, 0o755)
  return scriptStatus(c, launch)
}
