// Capture the real app's window without showing it: run the built app with MAKI_OFFSCREEN,
// optionally click through, and save the page as a PNG. (Ozone's headless platform renders
// nothing to capture, so this uses a hidden offscreen window on the normal one.)
//
//   npm run build && npx electron scripts/screenshot.cjs OUT.png [--fake] [--size WxH]
//       [--click TEXT | --fill PLACEHOLDER=TEXT | --wait MS]... [--scroll TEXT]
//
// --fake connects to a fake maki on 127.0.0.1:7878 first (start it beforehand). Then the steps,
// in order: --click presses the first button whose text includes TEXT (and waits for the fake to
// approve), --fill types TEXT into the field whose placeholder is PLACEHOLDER, --wait waits MS
// (for the network, say). --scroll brings the section whose heading includes TEXT to the top
// before the capture; --size WIDTHxHEIGHT sizes the window first (a tall one shows a whole page).
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const argv = process.argv
const out = argv.find((a) => a.endsWith('.png'))
const fake = argv.includes('--fake')
const after = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []))
const scroll = after('--scroll')[0]
const size = after('--size')[0]?.split('x').map(Number)
const steps = argv.flatMap((a, i) => (['--click', '--fill', '--wait'].includes(a) && argv[i + 1] ? [[a, argv[i + 1]]] : []))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

process.env.MAKI_OFFSCREEN = '1'
require(join(__dirname, '../out/main/index.js'))

app.whenReady().then(async () => {
  await wait(1500)
  const win = BrowserWindow.getAllWindows()[0]
  const run = (js) => win.webContents.executeJavaScript(js)
  if (size) {
    win.setMinimumSize(1, 1)
    win.setSize(size[0], size[1])
    await wait(500)
  }
  if (fake) {
    await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('fake'))?.click()`)
    await wait(5000) // handshake, then a Roughtime round trip
  }
  for (const [step, arg] of steps) {
    if (step === '--wait') {
      await wait(Number(arg))
    } else if (step === '--click') {
      await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(arg)}))?.click()`)
      await wait(2500) // the fake approves after a moment
    } else {
      const [placeholder, ...text] = arg.split('=')
      // React watches the value's setter, not the property: set it the way typing does
      await run(`(() => {
        const input = document.querySelector(${JSON.stringify(`input[placeholder="${placeholder}"]`)})
        if (!input) return
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text.join('='))})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await wait(300)
    }
  }
  if (scroll) {
    await run(
      `[...document.querySelectorAll('h2')].find((h) => h.textContent.includes(${JSON.stringify(scroll)}))?.closest('section')?.scrollIntoView()`
    )
    await wait(300)
  }
  writeFileSync(out, (await win.webContents.capturePage()).toPNG())
  app.quit()
})
