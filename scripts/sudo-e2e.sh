#!/usr/bin/env bash
# maki's sudo plugin with the real sudo, as root in a Fedora container (podman): maki desktop's
# setup script puts it in place, sudo loads it, and each command waits for the Sudo app on the fake
# maki, through maki desktop's socket and the link; then it's turned off. Needs podman, cargo, node,
# the network (for the container's packages), and the firmware repo beside this one (the fake maki
# and the Sudo app).
#
#     scripts/sudo-e2e.sh
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
fw=$here/../xous-core
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cargo build --release --quiet --manifest-path "$here/sudo/Cargo.toml"
(cd "$fw" && cargo build --quiet -p maki-proto --features fake --example fake_maki)
cp "$here/sudo/target/release/libmaki_sudo.so" "$work/maki_sudo.so"
cp "$fw/target/debug/examples/fake_maki" "$fw/libs/maki-wasm/tests/fixtures/sudo.maki" "$work/"
"$here/node_modules/.bin/esbuild" "$here/scripts/sudo-e2e.ts" --bundle --platform=node --format=cjs \
  --outfile="$work/e2e.cjs" --log-level=warning
node "$work/e2e.cjs" scripts "$work"

cat > "$work/run.sh" <<'EOF'
set -euo pipefail
dnf -y -q install sudo nodejs util-linux >/dev/null 2>&1
useradd -m -u 1000 kara
useradd -m -u 1001 bob
printf 'kara ALL=(ALL) NOPASSWD: ALL\nbob ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/users
chmod 0440 /etc/sudoers.d/users
install -d -m 0700 -o kara -g kara /run/user/1000
as() { local who=$1; shift; runuser -u "$who" -- env XDG_RUNTIME_DIR=/run/user/1000 "$@"; }
ok() { echo "ok: $*"; }
fail() { echo "FAILED: $*"; echo '--- the fake maki said:'; cat /tmp/maki.log; exit 1; }
start() {
  as kara /work/fake_maki 127.0.0.1:7878 --name uni --app /work/sudo.maki "$@" > /tmp/maki.log 2>&1 &
  echo $! > /tmp/maki.pid
  for _ in $(seq 50); do grep -q listening /tmp/maki.log && break; sleep 0.2; done
  rm -f /tmp/key
  as kara node /work/e2e.cjs bridge 7878 /tmp/key > /tmp/bridge.log 2>&1 &
  echo $! > /tmp/bridge.pid
  for _ in $(seq 50); do [ -s /tmp/key ] && break; sleep 0.2; done
  [ -s /tmp/key ] || fail "maki desktop's socket didn't come up: $(cat /tmp/bridge.log)"
}
stop() { kill "$(cat /tmp/bridge.pid)" "$(cat /tmp/maki.pid)" 2>/dev/null || true; sleep 0.5; }
shown() { grep -qF -- "$1" /tmp/maki.log || fail "maki didn't show: $1"; }
installer() { sh -c "$(cat /work/install.sh)" maki-sudo "$@"; }
uninstaller() { sh -c "$(cat /work/uninstall.sh)" maki-sudo; }

# a plugin sudo won't load: the setup puts sudo.conf back, and sudo still works
head -c 4096 /dev/urandom > /tmp/bad.so
if installer /tmp/bad.so "$(sha256sum /tmp/bad.so | cut -d' ' -f1)" "$(printf '%044d' 0 | tr 0 A | sed 's/A$/=/')" uni kara 2> /tmp/err; then fail "a broken plugin was set up"; fi
grep -q "wouldn't start" /tmp/err || fail "no word of why: $(cat /tmp/err)"
! grep -q maki_approval /etc/sudo.conf || fail "sudo.conf kept the broken plugin"
[ ! -e /usr/local/libexec/maki/maki_sudo.so ] || fail "the broken plugin was left in place"
[ "$(as kara sudo -n /usr/bin/id -u)" = 0 ] || fail "sudo broke"
ok "a plugin sudo won't load leaves sudo as it was"
# a plugin that isn't the one checked
cp /work/maki_sudo.so /tmp/other.so && printf x >> /tmp/other.so
if installer /tmp/other.so "$(sha256sum /work/maki_sudo.so | cut -d' ' -f1)" "$(printf '%044d' 0 | tr 0 A | sed 's/A$/=/')" uni kara 2> /tmp/err; then fail "a changed plugin was set up"; fi
grep -q "isn't what maki desktop checked" /tmp/err || fail "no word of why: $(cat /tmp/err)"
ok "a plugin that isn't what was checked isn't set up"

start
installer /work/maki_sudo.so "$(sha256sum /work/maki_sudo.so | cut -d' ' -f1)" "$(cat /tmp/key)" uni kara
grep -q "^Plugin maki_approval /usr/local/libexec/maki/maki_sudo.so users=kara$" /etc/sudo.conf || fail "sudo.conf: $(cat /etc/sudo.conf)"
[ "$(stat -c '%U %a' /etc/maki/sudo.pub)" = "root 644" ] || fail "the key file isn't root's alone"
as kara sudo -V | grep -q "maki's sudo approval plugin version" || fail "sudo didn't load it"
ok "set up for kara, and sudo loads it"

[ "$(as kara sudo -n /usr/bin/id -u)" = 0 ] || fail "a yes on maki didn't run it"
shown "shows [Command] id /usr/bin/id -u"
shown "Run it as root? sudo on"
as kara sudo -n LD_PRELOAD=/nonexistent.so /usr/bin/true 2>/dev/null || fail "a yes didn't run it"
shown "shows [Given]  LD_PRELOAD=/nonexistent.so"
as kara env SUDO_EDITOR=/usr/bin/true sudoedit -n /etc/hosts || fail "a yes didn't edit"
shown "shows [Edit]  /etc/hosts"
shown "Edit as root?"
ok "each command runs once maki says yes, shown whole: its arguments, its environment, sudoedit's files"

# root, and bob, aren't the users it's for
[ "$(sudo -n /usr/bin/id -u)" = 0 ] || fail "root's sudo waited for maki"
[ "$(as bob sudo -n /usr/bin/id -u)" = 0 ] || fail "bob's sudo waited for maki"
ok "others' commands go ahead on sudoers' say"

stop
start --deny
if as kara sudo -n /usr/bin/id 2> /tmp/err; then fail "a no on maki ran it"; fi
grep -q "you said no on maki" /tmp/err || fail "no word of the no: $(cat /tmp/err)"
stop
if as kara sudo -n /usr/bin/id 2> /tmp/err; then fail "it ran with no maki to ask"; fi
grep -q "maki desktop isn't running" /tmp/err || fail "no word of why: $(cat /tmp/err)"
ok "a no, or no maki to ask, and it doesn't run"

# a key file someone else could change: sudo won't run anything for kara
start
chmod g+w /etc/maki/sudo.pub
if as kara sudo -n /usr/bin/id 2> /tmp/err; then fail "it trusted a key file others can change"; fi
grep -q "can be changed by others" /tmp/err || fail "no word of why: $(cat /tmp/err)"
chmod g-w /etc/maki/sudo.pub
# a stand-in for maki desktop signing with another key
stop
cat > /tmp/impostor.js <<'JS'
const net = require('net'), fs = require('fs'), crypto = require('crypto')
const { privateKey } = crypto.generateKeyPairSync('ed25519')
const path = '/run/user/1000/maki-1000.sock'
try { fs.unlinkSync(path) } catch {}
net.createServer((s) => s.on('data', (d) => {
  const msg = Buffer.from(JSON.parse(d.toString()).data, 'base64')
  const sig = crypto.sign(null, Buffer.concat([Buffer.from('maki sudo approval\0'), msg.subarray(1)]), privateKey)
  s.write(JSON.stringify({ id: 1, ok: true, type: 'appMessage', status: 'approved', data: Buffer.concat([Buffer.of(0), sig]).toString('base64') }) + '\n')
})).listen(path)
JS
as kara node /tmp/impostor.js & impostor=$!
sleep 1
if as kara sudo -n /usr/bin/id 2> /tmp/err; then fail "another key's yes ran it"; fi
grep -q "isn't signed by the maki sudo trusts" /tmp/err || fail "no word of why: $(cat /tmp/err)"
kill $impostor
ok "a key file others can change, or a yes by another key, and it doesn't run"

uninstaller
! grep -q maki_approval /etc/sudo.conf || fail "sudo.conf still has it"
[ ! -e /usr/local/libexec/maki/maki_sudo.so ] && [ ! -e /etc/maki/sudo.pub ] || fail "files left behind"
[ "$(as kara sudo -n /usr/bin/id -u)" = 0 ] || fail "sudo didn't work once it was off"
ok "turned off: sudo as it was"
echo "all passed"
EOF

# the users in the container read it too
chmod -R a+rX "$work"
podman run --rm -v "$work:/work:Z" registry.fedoraproject.org/fedora:44 bash /work/run.sh
