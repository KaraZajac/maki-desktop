#!/bin/sh
# The browser extension as the stores take it, from a clean checkout of a commit:
#
#     scripts/extension-release.sh [OUT]        (OUT: default out/extension)
#
#   maki-extension-VERSION-firefox.xpi       unsigned, for about:debugging and Zen as it is today
#   maki-extension-VERSION-chrome.zip        for Load unpacked (its key keeps the ID maki desktop knows)
#   maki-extension-VERSION-chrome-store.zip  for the Chrome Web Store, which keeps the key itself
#   maki-extension-VERSION-source.zip        the source the reviewers rebuild it from, with BUILD.md
#   maki-extension-VERSION-firefox-signed.xpi, with WEB_EXT_API_KEY and WEB_EXT_API_SECRET set (an
#       addons.mozilla.org API key): signed by Mozilla, listed there (AMO_CHANNEL=unlisted to keep
#       it off the listing), the source and extension/amo-metadata.json sent with it
#
# Every file is built from the commit, not the working tree: the reviewers' build from the source
# archive must come out the same, byte for byte, and this checks that it does.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-$HERE/out/extension}" && cd "${1:-$HERE/out/extension}" && pwd)
cd "$HERE"
[ -z "$(git status --porcelain -- extension scripts package.json package-lock.json)" ] ||
    { echo "commit the extension first: a release is built from a commit"; exit 1; }
COMMIT=$(git rev-parse --short HEAD)
VERSION=$(node -p "require('./extension/manifest.chrome.json').version")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# the source, as reviewers get it
git archive --format=zip -o "$OUT/maki-extension-$VERSION-source.zip" --prefix=maki-desktop/ HEAD
cat > "$WORK/BUILD.md" <<EOF
# Building the maki extension $VERSION

From this archive (maki-desktop at $COMMIT), on Linux with Node $(node -v) and npm $(npm -v):

    cd maki-desktop
    npm ci --ignore-scripts
    MAKI_COMMIT=$COMMIT node extension/build.mjs

The extension is then in extension/dist/firefox (and extension/dist/chrome). Its scripts are
bundled by esbuild from extension/src, not minified. MAKI_COMMIT puts the commit it's built from
in THIRD-PARTY-NOTICES.md, as Git would.

The extension is the browser's side of maki, a hardware security key with a screen: it asks maki
desktop (a separate app, on this computer, over native messaging) for logins, codes and
signatures, which maki gives only after its owner approves on its own screen.
EOF
mkdir -p "$WORK/add/maki-desktop" && cp "$WORK/BUILD.md" "$WORK/add/maki-desktop/"
(cd "$WORK/add" && zip -q "$OUT/maki-extension-$VERSION-source.zip" maki-desktop/BUILD.md)

# built from the source archive, as the reviewers will
mkdir "$WORK/rebuild"
(cd "$WORK/rebuild" && unzip -q "$OUT/maki-extension-$VERSION-source.zip" &&
    cd maki-desktop && npm ci --ignore-scripts --silent >/dev/null 2>&1 &&
    MAKI_COMMIT=$COMMIT node extension/build.mjs >/dev/null)
DIST=$WORK/rebuild/maki-desktop/extension/dist

# and from here, to check they're the same
MAKI_COMMIT=$COMMIT node extension/build.mjs >/dev/null
diff -r extension/dist "$DIST" >/dev/null ||
    { echo "the build from the source archive isn't the same as this one"; exit 1; }
npx --yes web-ext@8 lint -s "$DIST/firefox" --warnings-as-errors=false >/dev/null ||
    { echo "web-ext lint found errors: npx web-ext lint -s extension/dist/firefox"; exit 1; }

# the same timestamps every time, so the archives are the same for the same commit
stamp() { TZ=UTC find "$1" -exec touch -d '2026-01-01 00:00:00' {} +; }
stamp "$DIST"
(cd "$DIST/firefox" && rm -f "$OUT/maki-extension-$VERSION-firefox.xpi" && zip -X -q -r "$OUT/maki-extension-$VERSION-firefox.xpi" .)
mkdir -p "$WORK/chrome/maki-extension-chrome"
cp -r "$DIST/chrome/." "$WORK/chrome/maki-extension-chrome/"
stamp "$WORK/chrome"
(cd "$WORK/chrome" && rm -f "$OUT/maki-extension-$VERSION-chrome.zip" && zip -X -q -r "$OUT/maki-extension-$VERSION-chrome.zip" maki-extension-chrome)
# the store's: no key (the store has its own), at the top of the archive
node -e "const f='$WORK/chrome/maki-extension-chrome/manifest.json',m=require(f);delete m.key;require('fs').writeFileSync(f,JSON.stringify(m,null,2)+'\n')"
stamp "$WORK/chrome"
(cd "$WORK/chrome/maki-extension-chrome" && rm -f "$OUT/maki-extension-$VERSION-chrome-store.zip" && zip -X -q -r "$OUT/maki-extension-$VERSION-chrome-store.zip" .)

if [ -n "${WEB_EXT_API_KEY:-}" ] && [ -n "${WEB_EXT_API_SECRET:-}" ]; then
    npx --yes web-ext@8 sign -s "$DIST/firefox" --channel="${AMO_CHANNEL:-listed}" \
        --upload-source-code="$OUT/maki-extension-$VERSION-source.zip" \
        --amo-metadata=extension/amo-metadata.json --artifacts-dir="$WORK/signed"
    mv "$WORK"/signed/*.xpi "$OUT/maki-extension-$VERSION-firefox-signed.xpi"
else
    echo "no WEB_EXT_API_KEY and WEB_EXT_API_SECRET: not signed by Mozilla"
fi
(cd "$OUT" && sha256sum maki-extension-"$VERSION"-* > "maki-extension-$VERSION.SHA256SUMS" && cat "maki-extension-$VERSION.SHA256SUMS")
