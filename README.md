# maki desktop

The computer's end of [maki](https://github.com/KaraZajac/BAOKEY): a small app that lives in the
tray, keeps a link to maki over USB, and keeps maki's clock right. The app store and the browser
extensions will come through here too.

> **Status: early.** Links over USB (Web Serial) or to a fake maki for development, syncs verified
> time, runs from the tray. Not yet packaged or signed.

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

## Develop

```sh
npm install
npm run dev          # the app, with hot reload
npm run typecheck
npm test             # unit tests, plus integration tests against the fake maki if it's built
MAKI_LIVE=1 npm test # also a real sync through the real Roughtime servers
```

The fake maki is the firmware's real protocol logic on a TCP socket. Build it in the firmware repo
(`KaraZajac/baokey-firmware`):

```sh
cargo build -p maki-proto --example fake_maki
target/debug/examples/fake_maki             # 127.0.0.1:7878; the app's "Use fake maki" button
```

Tests look for it at `../xous-core/target/debug/examples/fake_maki` (the BAOKEY checkout layout), or
at `$MAKI_FAKE`.

To look at the UI without a window appearing: `npm run build && npx electron scripts/screenshot.cjs
out.png [--fake]`.

## Layout

```
src/shared/protocol.ts   framing and message encoding, mirroring libs/maki-proto (PROTOCOL.md)
src/shared/client.ts     one request at a time over any transport; the time-sync dance
src/shared/link.ts       the link: probe, heartbeat, auto sync, drop
src/main/                tray, window, Roughtime UDP relay, start-at-login, dev TCP transport
src/renderer/            Web Serial discovery (usb.ts) and the window
scripts/icons.py         draws the icons in resources/
```

The protocol is specified in the firmware repo, `libs/maki-proto/PROTOCOL.md`. Change both together.

## Notes

- Web Serial lives in the renderer, so the window is hidden rather than destroyed, and background
  throttling is off: a throttled hidden window would miss heartbeats.
- npm here holds install scripts until approved. `esbuild` is approved (`allowScripts` in
  package.json); `electron-winstaller` isn't, since we don't build Squirrel installers.
