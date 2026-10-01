// Build the extension for Chrome (and Chromium, Brave, Edge, Vivaldi) and for Firefox.
//   node extension/build.mjs   ->   extension/dist/chrome, extension/dist/firefox
// Each carries LICENSE and THIRD-PARTY-NOTICES.md: the code of others its scripts bundle.
import { build } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { extensionNotices } from '../scripts/notices.mjs'

const version = JSON.parse(readFileSync('extension/manifest.chrome.json', 'utf8')).version

for (const target of ['chrome', 'firefox']) {
  const out = `extension/dist/${target}`
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const r = await build({
    entryPoints: ['extension/src/background.ts', 'extension/src/content.ts', 'extension/src/inpage.ts', 'extension/src/popup.ts'],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    outdir: out,
    logLevel: 'warning',
    metafile: true
  })
  cpSync(`extension/manifest.${target}.json`, `${out}/manifest.json`)
  cpSync('extension/popup.html', `${out}/popup.html`)
  cpSync('extension/icons', `${out}/icons`, { recursive: true })
  cpSync('LICENSE', `${out}/LICENSE`)
  // the packages esbuild put in the scripts: their notices go with them
  const packages = new Set()
  for (const input of Object.keys(r.metafile.inputs)) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)
    if (m) packages.add(resolve(m[1]))
  }
  writeFileSync(`${out}/THIRD-PARTY-NOTICES.md`, extensionNotices(packages, version))
}
console.log('built extension/dist/chrome and extension/dist/firefox')
