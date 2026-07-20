#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
identity=${SOLOTRACE_CODESIGN_IDENTITY:-}
notary_profile=${SOLOTRACE_NOTARY_PROFILE:-}
notary_keychain=${SOLOTRACE_NOTARY_KEYCHAIN:-}

if [ -z "$identity" ] || [ -z "$notary_profile" ]; then
  echo "Set SOLOTRACE_CODESIGN_IDENTITY and SOLOTRACE_NOTARY_PROFILE." >&2
  exit 1
fi
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Release requires a clean checkout." >&2
  exit 1
fi

version=$(cd "$root" && uv run python -c \
  'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')
build_id=${SOLOTRACE_BUILD_ID:-$(date -u +%Y%m%d%H%M)}
release_dir="$root/dist/release"
staging="$root/build/dmg"
dmg="$release_dir/SoloTrace-$version-macOS-arm64.dmg"

cd "$root"
SOLOTRACE_BUILD_ID="$build_id" \
SOLOTRACE_CODESIGN_IDENTITY="$identity" \
./scripts/package-macos.sh
./scripts/smoke-app.sh

./scripts/sign-macos-app.sh \
  dist/SoloTrace.app "$identity" packaging/entitlements.plist
codesign --verify --deep --strict --verbose=2 dist/SoloTrace.app

rm -rf "$staging"
mkdir -p "$staging" "$release_dir"
ditto dist/SoloTrace.app "$staging/SoloTrace.app"
cp -R docs/beta "$staging/Beta Guide"
ln -s /Applications "$staging/Applications"
hdiutil create \
  -volname "SoloTrace $version" \
  -srcfolder "$staging" \
  -ov -format UDZO "$dmg"

if [ -n "$notary_keychain" ]; then
  xcrun notarytool submit "$dmg" \
    --keychain-profile "$notary_profile" \
    --keychain "$notary_keychain" \
    --wait
else
  xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait
fi
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
shasum -a 256 "$dmg" > "$dmg.sha256"
echo "Released $dmg"
