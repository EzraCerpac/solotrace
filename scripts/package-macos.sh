#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_id=${SOLOTRACE_BUILD_ID:-$(date -u +%Y%m%d%H%M)}

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "SoloTrace.app must be built on Apple Silicon macOS." >&2
  exit 1
fi

cd "$root"
pnpm --dir web build
./scripts/build-ffmpeg-macos.sh
UV_CACHE_DIR="$root/.uv-cache" uv sync --group desktop
UV_CACHE_DIR="$root/.uv-cache" uv run python \
  scripts/collect-python-licenses.py build/macos/licenses
UV_CACHE_DIR="$root/.uv-cache" uv run python \
  scripts/write-build-metadata.py \
  pyproject.toml build/macos/solotrace-build.json "$build_id"
UV_CACHE_DIR="$root/.uv-cache" uv run pyinstaller \
  --clean --noconfirm packaging/solotrace.spec

codesign --verify --deep --strict --verbose=2 dist/SoloTrace.app
test "$(plutil -extract CFBundleShortVersionString raw dist/SoloTrace.app/Contents/Info.plist)" = \
  "$(UV_CACHE_DIR="$root/.uv-cache" uv run python -c \
    'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')"
file dist/SoloTrace.app/Contents/MacOS/SoloTrace | grep -q arm64
echo "Built $root/dist/SoloTrace.app"
