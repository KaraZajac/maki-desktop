// Third-party notices for what maki desktop ships.
//
//   node scripts/notices.mjs      writes out/THIRD-PARTY-NOTICES.md, for the app (the AppImage
//                                 carries it beside the app, with LICENSE); extension/build.mjs
//                                 writes the extension's, with the same functions
//
// What's listed is what's in the package: the npm packages bundled into the window, the preload
// and the main process (esbuild says which, from the same entry points), the runtime dependencies
// the app carries in its archive, and the Rust crates in sudo's plugin (cargo tree says which).
// Each comes with its license and its authors' notices: its LICENSE files, or, if it has none, the
// license its package names, with its authors. Where one offers a choice, the notice is MIT's.
// Electron and Chromium's own are LICENSE.electron.txt and LICENSES.chromium.html, beside the app.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The node_modules packages esbuild puts in a bundle from these entry points. */
export async function bundled(entryPoints, { platform = 'browser', external = [] } = {}) {
  const r = await build({
    entryPoints,
    bundle: true,
    write: false,
    metafile: true,
    platform,
    logLevel: 'silent',
    external: [...external, 'electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    alias: { '@shared': join(ROOT, 'src/shared') },
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' },
    jsx: 'automatic'
  })
  const dirs = new Set()
  for (const input of Object.keys(r.metafile.inputs)) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)
    if (m) dirs.add(resolve(ROOT, m[1]))
  }
  return dirs
}

/** The runtime dependencies the app carries (npm ls --omit=dev), as package folders. */
export function carried() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: ROOT, encoding: 'utf8' })
  return new Set(out.split('\n').filter((l) => l.includes('node_modules')))
}

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const PREFERRED = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', 'Zlib', 'BSL-1.0', 'Unicode-3.0', 'Unicode-DFS-2016', '0BSD', 'Unlicense', 'CC0-1.0']
const NO_NOTICE = new Set(['0BSD', 'Unlicense', 'CC0-1.0', 'MIT-0'])

/** What a license file is. */
function kindOf(text) {
  const t = text.slice(0, 4000)
  if (/Apache License/.test(t) && /Version 2\.0/.test(t)) return 'Apache-2.0'
  if (/Permission is hereby granted, free of charge/.test(t)) return 'MIT'
  if (/Redistribution and use in source and binary forms/.test(t)) return /Neither the name|endorse or promote/.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause'
  if (/Permission to use, copy, modify, and(\/or)? distribute/.test(t)) return 'ISC'
  if (/This software is provided 'as-is'/.test(t)) return 'Zlib'
  if (/This is free and unencumbered software/.test(t)) return 'Unlicense'
  if (/UNICODE/i.test(t) && /LICENSE/i.test(t)) return 'Unicode-3.0'
  return null
}

/** The licenses to give notice of: one of each OR, all of an AND. */
function choose(expr) {
  const parts = String(expr ?? '').replace(/[()]/g, '').replace(/\//g, ' OR ').split(/\bAND\b/)
  const chosen = []
  for (const part of parts) {
    const options = part.split(/\bOR\b/).map((o) => o.trim().replace(/\s+WITH\s+.*$/, '')).filter(Boolean)
    const best = PREFERRED.find((p) => options.includes(p)) ?? options[0]
    if (best && !chosen.includes(best)) chosen.push(best)
  }
  return chosen
}

const licenseFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => /^(LICEN[CS]E|COPYING|NOTICE)/i.test(f)).map((f) => join(dir, f)) : []

/** Its notices: its own files for the licenses taken, its NOTICE; or the license, with its authors. */
function notices({ license, authors, dir }) {
  const byKind = new Map()
  const out = []
  for (const f of licenseFiles(dir)) {
    const text = readFileSync(f, 'utf8').trim()
    if (/^NOTICE/i.test(f.split('/').pop())) out.push(['NOTICE', text])
    else if (!byKind.has(kindOf(text))) byKind.set(kindOf(text), text)
  }
  let chosen = choose(license)
  if (!chosen.length) chosen = [...byKind.keys()].filter(Boolean).slice(0, 1)
  for (const lic of chosen) {
    if (NO_NOTICE.has(lic)) continue
    let text = byKind.get(lic) ?? (byKind.size === 1 && chosen.length === 1 ? [...byKind.values()][0] : null)
    if (text && kindOf(text) === 'Apache-2.0') {
      const mine = text.split('\n').filter((l) => /^\s*Copyright/.test(l) && !l.includes('[yyyy]')).map((l) => l.trim())
      text = ['Licensed under the Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0', ...mine, authors ? `Authors: ${authors}` : ''].filter(Boolean).join('\n')
    }
    if (!text) {
      text =
        lic === 'MIT'
          ? `MIT License\n\nCopyright (c) ${authors || 'its authors'}\n\n${MIT}`
          : `Licensed under ${lic} (https://spdx.org/licenses/${lic}.html)${authors ? `, by ${authors}` : ''}.`
    }
    out.push([lic, text])
  }
  return out
}

const person = (a) => (typeof a === 'string' ? a.replace(/\s*[<(].*$/, '') : a?.name ?? '')

/** npm packages, from their folders. */
export function npmItems(dirs) {
  const items = new Map()
  for (const dir of dirs) {
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) continue
    const p = JSON.parse(readFileSync(pkgFile, 'utf8'))
    if (p.name === 'maki-desktop') continue
    const authors = [p.author, ...(p.contributors ?? [])].map(person).filter(Boolean).join(', ')
    items.set(`${p.name}@${p.version}`, {
      name: p.name,
      version: p.version,
      license: typeof p.license === 'string' ? p.license : p.license?.type,
      source: typeof p.repository === 'string' ? p.repository : p.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') ?? `npm: ${p.name}`,
      authors,
      dir
    })
  }
  return [...items.values()]
}

/** The crates compiled into a Rust library (sudo's plugin), not counting its own. */
export function rustItems(manifestDir) {
  const tree = execFileSync('cargo', ['tree', '-e', 'normal,no-proc-macro', '--prefix', 'none', '--format', '{p}'], { cwd: manifestDir, encoding: 'utf8' })
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1'], { cwd: manifestDir, encoding: 'utf8', maxBuffer: 1 << 28 }))
  const items = new Map()
  for (const line of tree.split('\n')) {
    const m = /^(\S+) v(\S+)/.exec(line.trim())
    if (!m) continue
    const p = meta.packages.find((x) => x.name === m[1] && x.version === m[2] && x.source)
    if (!p) continue // its own
    items.set(p.id, {
      name: p.name,
      version: p.version,
      license: p.license,
      source: p.repository ?? 'crates.io',
      authors: (p.authors ?? []).map((a) => a.replace(/\s*<.*$/, '')).join(', '),
      dir: dirname(p.manifest_path)
    })
  }
  return [...items.values()]
}

/** A notices file: the list, then each distinct text once, naming what it covers. */
export function render(title, intro, sections) {
  const lines = [`# ${title}`, '', intro, '']
  for (const [heading, items] of sections) {
    if (!items.length) continue
    lines.push(`## ${heading}`, '', '| Package | Version | License | Source |', '|---|---|---|---|')
    for (const i of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`| ${i.name} | ${i.version} | ${i.license ?? 'none declared'} | ${i.source} |`)
    }
    lines.push('')
  }
  const groups = new Map()
  for (const [, items] of sections) {
    for (const i of items) {
      for (const [lic, text] of notices(i)) {
        const key = createHash('sha256').update(text).digest('hex')
        if (!groups.has(key)) groups.set(key, { lic, text, covers: [] })
        groups.get(key).covers.push(`${i.name} ${i.version}`)
      }
    }
  }
  lines.push('## Their notices', '')
  for (const g of [...groups.values()].sort((a, b) => a.lic.localeCompare(b.lic) || a.covers[0].localeCompare(b.covers[0]))) {
    lines.push(`### ${g.lic}: ${[...new Set(g.covers)].sort().join(', ')}`, '', '```', g.text.replace(/```/g, "'''"), '```', '')
  }
  return lines.join('\n')
}

// MAKI_COMMIT names it where there's no Git: built from a source archive (the store reviewers'
// build of the extension), the notices must still be the same as the release's
const commit = () => {
  if (process.env.MAKI_COMMIT) return process.env.MAKI_COMMIT
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** The app's notices. */
export async function appNotices() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  const inBundles = new Set([
    ...(await bundled([join(ROOT, 'src/main/index.ts')], { platform: 'node', external: deps })),
    ...(await bundled([join(ROOT, 'src/preload/index.ts')], { platform: 'node', external: deps })),
    ...(await bundled([join(ROOT, 'src/renderer/src/main.tsx')]))
  ])
  // Tailwind's own CSS (its reset, from modern-normalize) is in the window's stylesheet
  inBundles.add(join(ROOT, 'node_modules/tailwindcss'))
  const npm = npmItems(new Set([...inBundles, ...carried()]))
  const rust = rustItems(join(ROOT, 'sudo'))
  return render(
    'Third-party notices',
    `For maki desktop ${pkg.version} (maki-desktop at \`${commit()}\`), made by \`scripts/notices.mjs\`. maki desktop is licensed under the MIT License (LICENSE). ` +
      'Electron and Chromium, which it runs on, give their notices in LICENSE.electron.txt and LICENSES.chromium.html, beside the app. ' +
      'What follows is everything else in it, with its license and its authors’ notices. Where a package offers a choice of licenses, the notice is for the one taken here (MIT, where offered). None is under a copyleft license.',
    [
      ['npm packages in the app', npm],
      ['Rust crates in sudo’s plugin (maki_sudo.so)', rust]
    ]
  )
}

/** The extension's notices, for the packages its bundles hold. */
export function extensionNotices(dirs, version) {
  return render(
    'Third-party notices',
    `For the maki browser extension ${version} (maki-desktop at \`${commit()}\`). The extension is licensed under the MIT License (LICENSE). ` +
      'What follows is the code of others its scripts carry, with its license and its authors’ notices.',
    [['npm packages in the extension', npmItems(dirs)]]
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(join(ROOT, 'out'), { recursive: true })
  writeFileSync(join(ROOT, 'out', 'THIRD-PARTY-NOTICES.md'), await appNotices())
  console.log('wrote out/THIRD-PARTY-NOTICES.md')
}
