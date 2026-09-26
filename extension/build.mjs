// Build the extension for Chrome (and Chromium, Brave, Edge, Vivaldi) and for Firefox.
//   node extension/build.mjs   ->   extension/dist/chrome, extension/dist/firefox
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'

for (const target of ['chrome', 'firefox']) {
  const out = `extension/dist/${target}`
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  await build({
    entryPoints: ['extension/src/background.ts', 'extension/src/content.ts', 'extension/src/popup.ts'],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    outdir: out,
    logLevel: 'warning'
  })
  cpSync(`extension/manifest.${target}.json`, `${out}/manifest.json`)
  cpSync('extension/popup.html', `${out}/popup.html`)
  cpSync('resources/icon.png', `${out}/icon.png`)
}
console.log('built extension/dist/chrome and extension/dist/firefox')
