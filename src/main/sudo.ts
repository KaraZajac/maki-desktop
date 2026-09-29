/**
 * sudo, with maki's yes: maki desktop's sudo plugin (sudo/ here, a sudo approval plugin) asks
 * maki's Sudo app about each command sudoers says yes to, through this app's socket and the link,
 * and the command runs only once maki's owner says yes on maki, where it's shown whole. maki's
 * answer is signed, and the plugin checks the signature against the key root keeps: nothing on
 * the computer can say yes for maki, not with the user's password nor sudo's remembered one.
 *
 * Setting it up, as root (the admin password, through pkexec): the plugin where sudo loads it,
 * maki's key where the plugin reads it (/etc/maki/sudo.pub), and its line in /etc/sudo.conf, for
 * this user; then sudo is started once, and if it won't start, sudo.conf and the plugin go back
 * as they were.
 * Turning it off takes them all away. Linux, with sudo 1.9 or later.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUDO_APP, keyLines, keyOf, type SudoStatus } from '../shared/sudo'
import type { AsAdmin } from './browsers'

export { SUDO_APP, keyLines, keyOf, type SudoStatus }
export const PLUGIN_DIR = '/usr/local/libexec/maki'
export const KEY_FILE = '/etc/maki/sudo.pub'
export const SUDO_CONF = '/etc/sudo.conf'
export const KEY_KIND = 'maki-sudo-ed25519'

/** sudo.conf's line for the plugin: its path and options. */
export function pluginLine(conf: string): { path: string; options: string[] } | null {
  for (const line of conf.split('\n')) {
    const m = /^\s*Plugin\s+maki_approval\s+(\S+)(.*)$/.exec(line)
    if (m) return { path: m[1], options: m[2].trim().split(/\s+/).filter(Boolean) }
  }
  return null
}

/** The keys in a key file, base64. */
export function keysIn(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const [kind, key] = line.trim().split(/\s+/)
    if (kind === KEY_KIND && key && /^[A-Za-z0-9+/]{43}=$/.test(key)) out.push(key)
  }
  return out
}

type Run = (cmd: string, args: string[]) => Promise<string>
const run: Run = (cmd, args) =>
  new Promise((ok, fail) =>
    execFile(cmd, args, { encoding: 'utf8', timeout: 10_000 }, (e, out, err) =>
      e ? fail(new Error(err || e.message)) : ok(out)
    )
  )

/** Whether it's set up, and what with. */
export async function sudoStatus(
  platform: string = process.platform,
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
  exec: Run = run
): Promise<SudoStatus> {
  const none: SudoStatus = {
    unavailable: null,
    version: null,
    on: false,
    users: null,
    keys: [],
    loads: false,
    problem: null
  }
  if (platform !== 'linux')
    return { ...none, unavailable: 'maki’s sudo plugin is for Linux, so far' }
  const line = pluginLine(await read(SUDO_CONF).catch(() => ''))
  const users =
    line?.options
      .find((o) => o.startsWith('users='))
      ?.slice(6)
      .split(',')
      .filter(Boolean) ?? null
  const keys = keysIn(await read(KEY_FILE).catch(() => ''))
  let said: string
  try {
    said = await exec('sudo', ['-V'])
  } catch (e) {
    const why = (e as Error).message.trim()
    // sudo stops before it says its version if a plugin can't start
    if (line && /plugin/.test(why)) return { ...none, on: true, users, keys, problem: why }
    return { ...none, unavailable: 'there’s no sudo here' }
  }
  const version = /^Sudo version (\S+)/m.exec(said)?.[1] ?? null
  if (!version) return { ...none, unavailable: 'there’s no sudo here' }
  const [major, minor] = version.split('.').map((n) => parseInt(n, 10))
  if (major < 1 || (major === 1 && minor < 9))
    return {
      ...none,
      version,
      unavailable: `sudo ${version} is older than 1.9, which approval plugins need`
    }
  return {
    unavailable: null,
    version,
    on: !!line,
    users: line ? users : null,
    keys,
    loads: /maki's sudo approval plugin version/.test(said),
    problem: null
  }
}

/**
 * The setup, as root: `sh -c INSTALL maki-sudo PLUGIN SHA256 KEY NAME USER`. The plugin is copied
 * to root's own folder before its hash is checked, so nothing can change it between the two.
 */
export const INSTALL = `set -eu
so=$1 sum=$2 key=$3 name=$4 user=$5
lib=${PLUGIN_DIR} conf=${SUDO_CONF} keys=${KEY_FILE}
fail() { echo "maki: $*" >&2; exit 1; }
case $key in *[!A-Za-z0-9+/=]*|'') fail "that isn't maki's key" ;; esac
[ \${#key} -eq 44 ] || fail "that isn't maki's key"
case $name in *[!A-Za-z0-9._-]*) fail "maki's name is odd" ;; esac
case $user in *[!A-Za-z0-9._-]*|''|-*) fail "that user name is odd" ;; esac
case $sum in *[!0-9a-f]*|'') fail "that isn't a hash" ;; esac
command -v sudo >/dev/null 2>&1 || fail "there's no sudo here"
install -d -m 0755 -o root -g root "$lib" /etc/maki
install -m 0644 -o root -g root "$so" "$lib/.maki_sudo.so.new"
if [ "$(sha256sum "$lib/.maki_sudo.so.new" | cut -d' ' -f1)" != "$sum" ]; then
  rm -f "$lib/.maki_sudo.so.new"
  fail "the plugin isn't what maki desktop checked"
fi
rm -f "$lib/.maki_sudo.so.was"
[ ! -e "$lib/maki_sudo.so" ] || cp -p "$lib/maki_sudo.so" "$lib/.maki_sudo.so.was"
mv -f "$lib/.maki_sudo.so.new" "$lib/maki_sudo.so"
[ -e "$keys" ] || install -m 0644 -o root -g root /dev/null "$keys"
chown root:root "$keys"
chmod 0644 "$keys"
grep -qF "${KEY_KIND} $key" "$keys" || printf '${KEY_KIND} %s %s\\n' "$key" "$name" >> "$keys"
[ -e "$conf" ] || install -m 0644 -o root -g root /dev/null "$conf"
had=$(sed -n 's/^[[:space:]]*Plugin[[:space:]][[:space:]]*maki_approval[[:space:]].*users=\\([^[:space:]]*\\).*/\\1/p' "$conf" | head -n 1)
users=$user
if [ -n "$had" ]; then
  case ",$had," in *",$user,"*) users=$had ;; *) users="$had,$user" ;; esac
fi
cp -p "$conf" "$conf.maki-was"
{ grep -Ev '^[[:space:]]*Plugin[[:space:]]+maki_approval([[:space:]]|$)' "$conf.maki-was" || true
  printf 'Plugin maki_approval %s/maki_sudo.so users=%s\\n' "$lib" "$users"; } > "$conf.maki-new"
chown root:root "$conf.maki-new"
chmod 0644 "$conf.maki-new"
mv -f "$conf.maki-new" "$conf"
if ! sudo -V >/dev/null 2>&1; then
  mv -f "$conf.maki-was" "$conf"
  if [ -e "$lib/.maki_sudo.so.was" ]; then mv -f "$lib/.maki_sudo.so.was" "$lib/maki_sudo.so"; else rm -f "$lib/maki_sudo.so"; fi
  fail "sudo wouldn't start with maki's plugin, so it's as it was"
fi
rm -f "$conf.maki-was" "$lib/.maki_sudo.so.was"
`

/** Turning it off, as root: `sh -c UNINSTALL maki-sudo`. sudo.conf first, so sudo never looks for a plugin that's gone. */
export const UNINSTALL = `set -eu
conf=${SUDO_CONF}
if [ -e "$conf" ]; then
  cp -p "$conf" "$conf.maki-was"
  { grep -Ev '^[[:space:]]*Plugin[[:space:]]+maki_approval([[:space:]]|$)' "$conf.maki-was" || true; } > "$conf.maki-new"
  chown root:root "$conf.maki-new"
  chmod 0644 "$conf.maki-new"
  mv -f "$conf.maki-new" "$conf"
  rm -f "$conf.maki-was"
fi
rm -f ${PLUGIN_DIR}/maki_sudo.so ${KEY_FILE}
rmdir ${PLUGIN_DIR} /etc/maki 2>/dev/null || true
`

/** maki's name as the key file's comment: a maki roll's, or nothing odd. */
function nameFor(name: string | null): string {
  const n = (name ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  return n || 'maki'
}

/**
 * Sets it up for `user`, trusting `key` (base64, from maki's Sudo app): the plugin at `plugin`
 * (this app's copy) goes to a folder of this user's first, as root can't read inside an AppImage.
 */
export async function sudoOn(
  plugin: string,
  key: string,
  makiName: string | null,
  user: string,
  asAdmin: AsAdmin
): Promise<void> {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('that isn’t maki’s key')
  const dir = await mkdtemp(join(tmpdir(), 'maki-sudo-'))
  try {
    const copy = join(dir, 'maki_sudo.so')
    await copyFile(plugin, copy)
    await chmod(copy, 0o644)
    const sum = createHash('sha256')
      .update(await readFile(copy))
      .digest('hex')
    await asAdmin(['/bin/sh', '-c', INSTALL, 'maki-sudo', copy, sum, key, nameFor(makiName), user])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function sudoOff(asAdmin: AsAdmin): Promise<void> {
  await asAdmin(['/bin/sh', '-c', UNINSTALL, 'maki-sudo'])
}
