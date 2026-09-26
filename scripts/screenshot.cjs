// Capture the real app's window without showing it: run the built app with MAKI_OFFSCREEN,
// optionally click through, and save the page as a PNG. (Ozone's headless platform renders
// nothing to capture, so this uses a hidden offscreen window on the normal one.)
//
//   npm run build && npx electron scripts/screenshot.cjs OUT.png [--fake] [--click TEXT]... [--scroll TEXT]
//
// --fake connects to a fake maki on 127.0.0.1:7878 first (start it beforehand). --click presses
// the first button whose text includes TEXT, in order; --scroll brings the section whose heading
// includes TEXT to the top before the capture.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const out = process.argv.find((a) => a.endsWith('.png'))
const fake = process.argv.includes('--fake')
const after = (flag) => process.argv.flatMap((a, i) => (a === flag && process.argv[i + 1] ? [process.argv[i + 1]] : []))
const clicks = after('--click')
const scroll = after('--scroll')[0]
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

process.env.MAKI_OFFSCREEN = '1'
require(join(__dirname, '../out/main/index.js'))

app.whenReady().then(async () => {
  await wait(1500)
  const win = BrowserWindow.getAllWindows()[0]
  if (fake) {
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('fake'))?.click()`
    )
    await wait(5000) // handshake, then a Roughtime round trip
  }
  for (const text of clicks) {
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))?.click()`
    )
    await wait(2500) // the fake approves after a moment
  }
  if (scroll) {
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('h2')].find((h) => h.textContent.includes(${JSON.stringify(scroll)}))?.closest('section')?.scrollIntoView()`
    )
    await wait(300)
  }
  writeFileSync(out, (await win.webContents.capturePage()).toPNG())
  app.quit()
})
