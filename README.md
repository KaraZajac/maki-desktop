# maki desktop

The computer's end of [maki](https://github.com/KaraZajac/maki): a small app that lives in the
tray, keeps a link to maki over USB, keeps maki's clock right, connects the maki browser
extension to maki, and brings it apps from the maki store. It looks like
[maki.netslum.io](https://maki.netslum.io): Catppuccin Mocha, with the peach of the salmon in
maki's roll for what to do and the green of the nori for what's done.

> **Status: early.** Links over USB (Web Serial) or to a fake maki for development, syncs verified
> time, runs from the tray, relays logins and TOTP codes between the browser extension and maki,
> keeps maki's encrypted backups, is a wallet with maki's Bitcoin and Ethereum apps, has maki
> sign Bitcoin transactions for wallet software, and gives sites maki's Ethereum account and its
> Nostr key through the extension. Tested end to end against
> the fake maki (the firmware's own protocol, app host and apps on a socket), including in real
> Chromium and Firefox. The firmware runs on a DC34 badge, linked over USB with its clock set
> through Roughtime, and in the emulator. Linux AppImage builds; nothing is signed.

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
- **Keeps backups.** On link, hourly, and soon after a login is saved, maki hands over its logins
  and codes encrypted with a key from its recovery phrase, and they're kept in the app's folder.
  "Restore to maki" sends the latest back; maki asks before adding anything.
- **Is a wallet.** maki's wallets are apps from the maki store, Bitcoin and Ethereum, for those
  who want them: maki keeps the keys, the app shows you what you sign on maki's screen, and the
  Wallets page offers the app when maki hasn't it. The page holds each account: Bitcoin (native SegWit and
  taproot, mainnet and testnet4; balance, coins and activity from mempool.space; a fresh address
  as a QR code, checked on maki; sending at the fee you choose, and speeding up one that's
  waiting) and Ethereum (what it holds on six networks, the tokens maki knows included; sending
  a coin or a token, to an address or an ENS name). maki shows every payment and signs it.
  Values in money if you pick a currency (CoinGecko, asked the same question for everyone).
- **Works with Bitcoin wallet software.** Get one of maki's accounts, native SegWit (BIP84) or
  taproot (BIP86), as an output descriptor for Sparrow or Bitcoin Core as a watch-only wallet;
  check an address on maki's screen before giving it out; and
  have maki sign a transaction (a PSBT file, or pasted base64 or hex). maki's Bitcoin app refuses
  anything that isn't its own wallet's, goes through every payment, the change and the fee with
  you, and maki signs only when you say so. The signed PSBT goes back to the wallet software to
  broadcast.
- **Gives sites an Ethereum account.** The extension puts an EIP-1193 provider in pages
  (`window.ethereum` when no other wallet has it, and announced the EIP-6963 way), which maki's
  Ethereum app answers. A site connects once you allow it on maki; messages (`personal_sign`), typed data
  (`eth_signTypedData_v4`, EIP-712: permits spelled out, anything else field by field) and
  transactions are shown on maki and signed there. This app fills in nonce, gas and fees from
  the network, builds the transaction (EIP-1559), and broadcasts what maki signed; reads go to
  public servers for Ethereum, Base, Optimism, Arbitrum, Polygon and Sepolia. Typed data for
  another network than the site is on, the older typed-data methods and `eth_sign` are
  refused.
- **Gives sites a Nostr key.** With maki's Nostr app installed, the extension puts
  `window.nostr` (NIP-07) in pages when no other signer has: maki asks before a site first sees
  the key, and shows each event (the site, its kind, how it begins) before signing it.
- **Installs apps on maki, from the maki store.** The Apps page shows maki's room for apps as a
  bar, a segment for each app (its bundle and the storage it asks for) and what's free, with how
  many more apps it has room for; what's installed; and the maki store, its apps in a grid by
  category, fetched from the store's repository ([KaraZajac/maki-apps](https://github.com/KaraZajac/maki-apps))
  and checked against the root this app carries, as maki checks it. Choosing one shows what it is,
  where it's from and the commit the store built it from (a link to the source), its developer's
  key, what it asks to do, and whether it fits; maki goes through the same on its screen and asks.
  A `.maki` file installs the same way, marked sideloaded (or `maki install app.maki` from the SDK,
  through this app). Software on this computer can send messages to apps that may talk to it (the
  link permission), through the local socket.
- **Decrypts age files with maki's key.** With maki's Age app installed, maki keeps an age key:
  its recipient is an ordinary `age1…` one, so anyone encrypts to it with age as it is. The
  Connections page installs `age-plugin-maki` (in `~/.local/bin`, this app in plugin mode) and
  saves an identity file naming maki's key; `age -d -i maki-age.txt file.age` then asks maki,
  which asks you on its screen before it hands over the file's key.
- **Is an SSH agent for maki's SSH app.** ssh and git talk to it (`SSH_AUTH_SOCK`, which the
  Connections page shows once the app is installed), and it hands each request to the app on maki, which
  reads what's to be signed, asks you, and signs. The agent holds no keys: `ssh-add -L` shows the
  app's public key, for servers' authorized_keys or for git (`git config gpg.format ssh`).

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
  maki's screen. It also puts maki's Ethereum provider in pages (`inpage.ts`, in the page's own
  world), which asks through the same path.
- The browser starts this app with `--native-host` (headless, no window) as a relay to the
  running tray app, starting that if needed. The extension hangs up after 30 s idle.
- **Set up** (Browsers, in the window) registers the relay with each installed browser. Firefox
  with its profile in `~/.config/mozilla` (new installs since Firefox 147) only reads these
  registrations from `~/.mozilla`, and creating `~/.mozilla` would switch it back to the old
  layout and an empty profile, so for that Firefox the registration goes in the system folder
  (`/usr/lib64/mozilla` or `/usr/lib/mozilla`) and asks for an admin password once.
- On **Windows** the registration is a registry key per browser (under `HKCU\Software\...\
  NativeMessagingHosts`, set with `reg.exe`) naming a manifest in `%APPDATA%\maki`, which points
  at a `maki-native-host.cmd` that starts this app as the relay; the local socket is a named
  pipe. Tested with the registry in memory, not yet on Windows itself.
- Not yet: usernames asked on a page of their own (they're typed; the password page fills),
  logins sent without a form submit, a published extension.

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
MAKI_AGE=/path/to/age npm test     # age-plugin-maki with the real age (or age on the PATH)
MAKI_E2E=1 npx vitest run src/e2e
                     # the app itself, offscreen, pressed through: the Wallets page sends from
                     # each account (and speeds one up), and offers the Bitcoin app to a maki
                     # without it; the Apps page installs and removes
```

The real-browser test uses Playwright's Chromium from `~/.cache/ms-playwright` (or
`$MAKI_CHROMIUM`) and `firefox` from the PATH (or `$MAKI_FIREFOX`). It gives Firefox a throwaway
HOME, so your own profile and `~/.mozilla` are never touched.

The fake maki is the firmware's real protocol logic on a TCP socket. Build it in the firmware repo
(`KaraZajac/maki-firmware`):

```sh
cargo build -p maki-proto --features fake --example fake_maki
target/debug/examples/fake_maki             # 127.0.0.1:7878; the app's "Use fake maki" button
target/debug/examples/fake_maki --clock-verified   # codes without syncing through Roughtime first
```

Tests look for it at `../xous-core/target/debug/examples/fake_maki` (the maki checkout layout), or
at `$MAKI_FAKE`.

The maki store comes from its repository, `KaraZajac/maki-apps` (its `store/` folder, on GitHub's
file server). `MAKI_STORE` points the app at another copy of the store, a folder or an https
address; a copy in a private GitHub repository needs a GitHub token that can read it, which the app
sends to GitHub's file server and nowhere else:

```sh
MAKI_STORE=../apps/store npm run dev          # a clone of maki-apps beside this one
MAKI_STORE_TOKEN=$(gh auth token) MAKI_STORE=https://raw.githubusercontent.com/you/private-copy/main/store/ npm run dev
```

The wallets read the networks through public servers: mempool.space's Esplora API for Bitcoin, and
each Ethereum network's public JSON-RPC servers. For tests, or your own servers:

```sh
MAKI_ESPLORA=http://127.0.0.1:3002/api npm run dev   # an Esplora API (your own node's), both networks
MAKI_ETH_RPC=http://127.0.0.1:8545 npm run dev        # one JSON-RPC server, for every network
MAKI_FAKE_PORT=7879 npm run dev                       # the fake maki on another port
```

To look at the UI without a window appearing: `npm run build && npx electron scripts/screenshot.cjs
out.png [--fake] [--size WxH] [--click TEXT | --fill PLACEHOLDER=TEXT | --wait MS | --until TEXT]...
[--scroll TEXT] [--dump FILE]`, e.g. `--fake --click Wallets --click "Add from maki" --until BTC`,
or `--fake --click Apps --size 1080x1500` for the whole Apps page. The steps run in order; the
script's header says what each does. The end-to-end tests drive the app with it.

## Layout

```
src/shared/protocol.ts   framing and message encoding, mirroring libs/maki-proto (PROTOCOL.md)
src/shared/client.ts     one request at a time over any transport; the time-sync dance
src/shared/link.ts       the link: probe, heartbeat, auto sync, drop; browser requests
src/shared/bridge-types.ts  what the extension may ask, checked field by field
src/shared/psbt.ts       PSBTs as wallet software hands them over: binary, base64, hex
src/shared/ethereum.ts   the EIP-1193 methods sites call, answered from maki and the network
src/shared/btc-wallet.ts the Bitcoin wallet: descriptors, the gap-limit scan, PSBTs maki reads
src/shared/eth-wallet.ts the Ethereum wallet: holdings on each network, sends through maki
src/shared/wallet-apps.ts maki's wallet apps, Bitcoin and Ethereum: their messages, over APP_MESSAGE
src/shared/tokens.ts     the tokens maki knows by contract (the firmware's table, kept in step)
src/shared/polite.ts     asking a public server politely: a few at a time, and waiting when told
src/shared/rlp.ts        RLP, and the unsigned EIP-1559 transactions maki signs
extension/src/inpage.ts  the page's Ethereum provider (the page's own world, EIP-6963)
src/main/                tray, window, Roughtime UDP relay, start-at-login, dev TCP transport
src/main/bridge.ts       the local socket the native host connects to
src/main/native-host.ts  --native-host: native messaging on stdio, relayed to the socket
src/main/browsers.ts     registering the native host with installed browsers
src/main/ssh-agent.ts    the SSH agent: each request to maki's SSH app, the answer back
src/renderer/            Web Serial discovery (usb.ts) and the window: a page each (Overview, Apps,
                         Wallets, Connections, Backups), ui.tsx for the pieces they're made of
extension/               the browser extension: background, content script, field finding
scripts/icons.py         draws the icons in resources/
```

The protocol is specified in the firmware repo, `libs/maki-proto/PROTOCOL.md`. Change both together.

## Notes

- Web Serial lives in the renderer, so the window is hidden rather than destroyed, and background
  throttling is off: a throttled hidden window would miss heartbeats.
- npm here holds install scripts until approved. `esbuild` is approved (`allowScripts` in
  package.json); `electron-winstaller` isn't, since we don't build Squirrel installers.
