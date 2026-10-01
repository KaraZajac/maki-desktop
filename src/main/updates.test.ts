/**
 * Updates against a computer in a folder: /sys with maki in update mode (and maki itself, which
 * must be left alone), /dev, a mount table, and udisksctl and stty that only say what they did.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReleaseFile } from '../shared/releases'
import {
  download,
  fetchRelease,
  installFirmware,
  replaceAppImage,
  updateConsole,
  updateDrive,
  type UpdatesEnv
} from './updates'
import type { FirmwareStep } from '../shared/releases'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'maki-updates-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

function fileOf(name: string, data: Uint8Array, url = `https://example.com/${name}`): ReleaseFile {
  return { name, platform: null, url, bytes: data.length, sha256: sha(data) }
}

/** fetch, serving `files` by address, and counting what it was asked for */
function fakeFetch(files: Record<string, Uint8Array>): typeof fetch & { asked: string[] } {
  const asked: string[] = []
  const f = (async (url: string | URL) => {
    asked.push(String(url))
    const body = files[String(url)]
    return body ? new Response(body, { status: 200 }) : new Response('no', { status: 404 })
  }) as unknown as typeof fetch & { asked: string[] }
  f.asked = asked
  return f
}

/** A USB device in the fake /sys: its id, and interfaces under it with ttys or a disk. */
function usb(
  env: UpdatesEnv,
  port: string,
  product: string,
  has: { tty?: string; disk?: string }
): void {
  const dev = join(env.sys, 'devices', 'pci0000:00', 'usb1', port)
  mkdirSync(dev, { recursive: true })
  writeFileSync(join(dev, 'idVendor'), '1d50\n')
  writeFileSync(join(dev, 'idProduct'), `${product}\n`)
  if (has.tty) {
    const t = join(dev, `${port}:1.2`, 'tty', has.tty)
    mkdirSync(t, { recursive: true })
    mkdirSync(join(env.sys, 'class', 'tty'), { recursive: true })
    symlinkSync(t, join(env.sys, 'class', 'tty', has.tty))
    writeFileSync(join(env.dev, has.tty), '')
  }
  if (has.disk) {
    const d = join(dev, `${port}:1.0`, 'host5', 'target5:0:0', '5:0:0:0', 'block', has.disk)
    mkdirSync(d, { recursive: true })
    mkdirSync(join(env.sys, 'class', 'block'), { recursive: true })
    symlinkSync(d, join(env.sys, 'class', 'block', has.disk))
    writeFileSync(join(env.dev, has.disk), '')
  }
}

function fakeEnv(): UpdatesEnv & { ran: string[][]; mnt: string } {
  const sys = join(root, 'sys')
  const dev = join(root, 'dev')
  const mnt = join(root, 'run', 'media', 'kara', 'BAOCHIP')
  const mounts = join(root, 'mounts')
  mkdirSync(sys, { recursive: true })
  mkdirSync(join(dev, 'disk', 'by-label'), { recursive: true })
  writeFileSync(mounts, '')
  const ran: string[][] = []
  return {
    ran,
    mnt,
    fetch: fakeFetch({}),
    sys,
    dev,
    mounts,
    udisksctl: async (args) => {
      ran.push(['udisksctl', ...args])
      mkdirSync(mnt, { recursive: true })
      writeFileSync(mounts, `${args[2]} ${mnt.replace(/ /g, '\\040')} vfat rw 0 0\n`)
      return `Mounted ${args[2]} at ${mnt}\n`
    },
    stty: async (tty, args) => void ran.push(['stty', tty, ...args]),
    sleep: async () => {}
  }
}

describe('downloads', () => {
  it('takes a file only if it’s what the store signed for', async () => {
    const data = new TextEncoder().encode('the new firmware')
    const good = fileOf('xous.uf2', data)
    const env = { fetch: fakeFetch({ [good.url]: data }) }
    const dest = join(root, 'cache', 'xous.uf2')
    await download(good, dest, env)
    expect(readFileSync(dest)).toEqual(Buffer.from(data))

    const other = { ...good, sha256: sha(new TextEncoder().encode('something else')) }
    await expect(download(other, join(root, 'cache', 'bad.uf2'), env)).rejects.toThrow(
      'isn’t what the maki store signed for'
    )
    expect(existsSync(join(root, 'cache', 'bad.uf2'))).toBe(false)
    expect(existsSync(join(root, 'cache', 'bad.uf2.part'))).toBe(false)

    const smaller = { ...good, bytes: 4 }
    await expect(download(smaller, join(root, 'cache', 'big.uf2'), env)).rejects.toThrow(
      'bigger than the store says'
    )
    await expect(
      download({ ...good, url: 'https://example.com/gone' }, join(root, 'gone'), env)
    ).rejects.toThrow('404')
  })

  it('fetches a release once, then finds it in the cache', async () => {
    const files: Record<string, Uint8Array> = {}
    const release = ['loader.uf2', 'xous.uf2', 'swap.uf2'].map((n) => {
      const data = new TextEncoder().encode(`${n} contents`)
      const f = fileOf(n, data)
      files[f.url] = data
      return f
    })
    const fetch = fakeFetch(files)
    const paths = await fetchRelease(release, join(root, 'cache'), { fetch })
    expect(Object.keys(paths)).toEqual(['loader.uf2', 'xous.uf2', 'swap.uf2'])
    expect(fetch.asked).toHaveLength(3)
    await fetchRelease(release, join(root, 'cache'), { fetch })
    expect(fetch.asked).toHaveLength(3)
  })
})

describe('maki’s update mode', () => {
  it('finds maki’s drive and console, never maki itself or another drive', async () => {
    const env = fakeEnv()
    // maki itself, linked: its serial port is ttyACM0
    usb(env, '1-2', '6198', { tty: 'ttyACM0' })
    expect(await updateConsole(env)).toBeNull()
    expect(await updateDrive(env)).toBeNull()
    // someone else's stick, labelled BAOCHIP
    symlinkSync('../../sdc', join(env.dev, 'disk', 'by-label', 'BAOCHIP'))
    usb(env, '1-3', '1234', { disk: 'sdc' })
    expect(await updateDrive(env)).toBeNull()
    // maki in update mode
    rmSync(join(env.dev, 'disk', 'by-label', 'BAOCHIP'))
    symlinkSync('../../sdb', join(env.dev, 'disk', 'by-label', 'BAOCHIP'))
    usb(env, '1-1', '6196', { tty: 'ttyACM1', disk: 'sdb' })
    expect(await updateDrive(env)).toBe(join(env.dev, 'sdb'))
    expect(await updateConsole(env)).toBe(join(env.dev, 'ttyACM1'))
  })

  it('puts the firmware on maki’s drive, mounted if it wasn’t, then boots it on the console', async () => {
    const env = fakeEnv()
    usb(env, '1-1', '6196', { tty: 'ttyACM0', disk: 'sdb' })
    symlinkSync('../../sdb', join(env.dev, 'disk', 'by-label', 'BAOCHIP'))
    const paths: Record<string, string> = {}
    for (const n of ['loader.uf2', 'xous.uf2', 'swap.uf2']) {
      paths[n] = join(root, n)
      writeFileSync(paths[n], `${n} contents`)
    }
    const steps: string[] = []
    await installFirmware(
      paths,
      (s: FirmwareStep, d?: string) => steps.push(d ? `${s} ${d}` : s),
      env
    )
    expect(steps).toEqual([
      'waiting',
      'mounting',
      'copying loader.uf2',
      'copying xous.uf2',
      'copying swap.uf2',
      'booting'
    ])
    for (const n of Object.keys(paths))
      expect(readFileSync(join(env.mnt, n), 'utf8')).toBe(`${n} contents`)
    expect(env.ran[0]).toEqual([
      'udisksctl',
      'mount',
      '-b',
      join(env.dev, 'sdb'),
      '--no-user-interaction'
    ])
    // raw and without echo before each line, and bootwait off before the boot
    expect(env.ran.slice(1)).toEqual([
      ['stty', join(env.dev, 'ttyACM0'), 'raw', '-echo'],
      ['stty', join(env.dev, 'ttyACM0'), 'raw', '-echo']
    ])
    expect(readFileSync(join(env.dev, 'ttyACM0'), 'utf8')).toBe('bootwait disable\rboot\r')
  })

  it('says so when maki never shows up in update mode', async () => {
    const env = fakeEnv()
    await expect(
      installFirmware({ 'loader.uf2': 'x', 'xous.uf2': 'x', 'swap.uf2': 'x' }, () => {}, env, 1_000)
    ).rejects.toThrow('didn’t show up in update mode')
  })
})

describe('maki desktop’s own update', () => {
  it('replaces an AppImage named for its version with one named for the new version', async () => {
    const data = new TextEncoder().encode('the new maki desktop')
    const f = fileOf('maki-desktop-0.1.3-x86_64.AppImage', data)
    const now = join(root, 'maki-desktop-0.1.2-x86_64.AppImage')
    writeFileSync(now, 'the old one')
    const next = await replaceAppImage(
      f,
      { path: now, version: '0.1.2', newVersion: '0.1.3' },
      { fetch: fakeFetch({ [f.url]: data }) }
    )
    expect(next).toBe(join(root, 'maki-desktop-0.1.3-x86_64.AppImage'))
    expect(readFileSync(next, 'utf8')).toBe('the new maki desktop')
    expect(existsSync(now)).toBe(false)
    // one named otherwise keeps its name
    const plain = join(root, 'maki.AppImage')
    writeFileSync(plain, 'old')
    const same = await replaceAppImage(
      f,
      { path: plain, version: '0.1.2', newVersion: '0.1.3' },
      { fetch: fakeFetch({ [f.url]: data }) }
    )
    expect(same).toBe(plain)
    expect(readFileSync(plain, 'utf8')).toBe('the new maki desktop')
    await expect(
      replaceAppImage(f, { path: undefined, version: '0.1.2', newVersion: '0.1.3' })
    ).rejects.toThrow('isn’t running from an AppImage')
  })
})
