# maki desktop

The computer's end of [maki](https://github.com/KaraZajac/BAOKEY): a small app that lives in the
tray, keeps a link to maki over USB, keeps maki's clock right, and connects the maki browser
extension to maki. The app store will come through here too.

> **Status: early.** Links over USB (Web Serial) or to a fake maki for development, syncs verified
> time, runs from the tray, and relays logins and TOTP codes between the browser extension and
> maki. Tested end to end against the fake maki, including in real Chromium and Firefox; the
> firmware's vault doesn't answer the browser yet. Linux AppImage builds; nothing is signed.

## What it does today

- **Finds maki by itself.** Any port with maki's USB IDs gets one short, inert HELLO; a device that
  doesn't answer (a stock DC34 badge shares the IDs) is left alone for the rest of the session.
- **Keeps the link alive.** A heartbeat every 10 s; maki shows a dot on its home screen while linked
  and drops it after 25 s of silence.
- **Keeps maki's clock right, verifiably.** On link and every 6 hours, maki builds Roughtime requests,
  this app carries them to three public servers over UDP, and maki checks the signed answers itself
  and needs two that agree. If Roughtime is unreachable it falls back to this computer's clock,
  which maki marks as unverified and never uses to overwrite a verified time.
- **Stays out of the way.** Closing the window keeps the link in the tray. `--hidden` starts in the
  tray; "Start at login" (window or tray menu) sets that up per OS.
- **Connects the browser to maki.** Click into a login field and the extension asks maki, through
  this app; maki shows the site and you approve on maki; the login fills. The same for TOTP code
  fields. Submit a login maki doesn't have and maki offers to keep it. See [Browsers](#browsers).

## Browsers

```
page ── content script ── background ══ native messaging ══ maki desktop --native-host
                                                                 │ local socket (user only)
                                                          maki desktop (tray) ══ USB ══ maki
```

- The **extension** (`extension/`, Manifest V3, one source for Chrome and Firefox) finds login and
  code fields, asks when you focus one, and fills what maki approves. The site it asks about is
  the hostname the browser reports for the asking frame, never something the page says; https
  only (and localhost). The page's own notices only say what's going on: the decision is made on
  maki's screen.
- The browser starts this app with `--native-host` (headless, no window) as a relay to the
  running tray app, starting that if needed. The extension hangs up after 30 s idle.
- **Set up** (Browsers, in the window) registers the relay with each installed browser. Firefox
  with its profile in `~/.config/mozilla` (new installs since Firefox 147) only reads these
  registrations from `~/.mozilla`, and creating `~/.mozilla` would switch it back to the old
  layout and an empty profile, so for that Firefox the registration goes in the system folder
  (`/usr/lib64/mozilla` or `/usr/lib/mozilla`) and asks for an admin password once.
- Not yet: Windows (it registers through the registry), usernames asked on a page of their own
  (they're typed; the password page fills), logins sent without a form submit, a published
  extension.

Load the extension by hand for now:

```sh
npm run build:extension     # extension/dist/chrome and extension/dist/firefox
```

- Chrome, Chromium, Brave, Edge, Vivaldi: `chrome://extensions`, Developer mode, Load unpacked,
  `extension/dist/chrome`. Its ID is pinned (`mjopengkegeglmalfedmanmplofncmdh`) by the key in
  the manifest, which is what the registration allows.
- Firefox: `about:debugging`, This Firefox, Load Temporary Add-on, `extension/dist/firefox/manifest.json`.
  It lasts until Firefox restarts; keeping it needs Mozilla to sign it (an unlisted AMO
  submission), or Firefox Developer Edition with `xpinstall.signatures.required` off.

## Develop

```sh
npm install
npm run dev          # the app, with hot reload
npm run typecheck
npm test             # unit tests, plus integration tests against the fake maki if it's built
MAKI_LIVE=1 npm test # also a real sync through the real Roughtime servers
MAKI_BROWSERS=1 npx vitest run extension/src/real-browsers.test.ts
                     # the extension in headless Chromium and Firefox, in throwaway profiles
```

The real-browser test uses Playwright's Chromium from `~/.cache/ms-playwright` (or
`$MAKI_CHROMIUM`) and `firefox` from the PATH (or `$MAKI_FIREFOX`). It gives Firefox a throwaway
HOME, so your own profile and `~/.mozilla` are never touched.

The fake maki is the firmware's real protocol logic on a TCP socket. Build it in the firmware repo
(`KaraZajac/baokey-firmware`):

```sh
cargo build -p maki-proto --features fake --example fake_maki
target/debug/examples/fake_maki             # 127.0.0.1:7878; the app's "Use fake maki" button
target/debug/examples/fake_maki --clock-verified   # codes without syncing through Roughtime first
```

Tests look for it at `../xous-core/target/debug/examples/fake_maki` (the BAOKEY checkout layout), or
at `$MAKI_FAKE`.

To look at the UI without a window appearing: `npm run build && npx electron scripts/screenshot.cjs
out.png [--fake]`.

## Layout

```
src/shared/protocol.ts   framing and message encoding, mirroring libs/maki-proto (PROTOCOL.md)
src/shared/client.ts     one request at a time over any transport; the time-sync dance
src/shared/link.ts       the link: probe, heartbeat, auto sync, drop; browser requests
src/shared/bridge-types.ts  what the extension may ask, checked field by field
src/main/                tray, window, Roughtime UDP relay, start-at-login, dev TCP transport
src/main/bridge.ts       the local socket the native host connects to
src/main/native-host.ts  --native-host: native messaging on stdio, relayed to the socket
src/main/browsers.ts     registering the native host with installed browsers
src/renderer/            Web Serial discovery (usb.ts) and the window
extension/               the browser extension: background, content script, field finding
scripts/icons.py         draws the icons in resources/
```

The protocol is specified in the firmware repo, `libs/maki-proto/PROTOCOL.md`. Change both together.

## Notes

- Web Serial lives in the renderer, so the window is hidden rather than destroyed, and background
  throttling is off: a throttled hidden window would miss heartbeats.
- npm here holds install scripts until approved. `esbuild` is approved (`allowScripts` in
  package.json); `electron-winstaller` isn't, since we don't build Squirrel installers.
