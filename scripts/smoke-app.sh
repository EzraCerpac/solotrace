#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app="$root/dist/SoloTrace.app"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/solotrace-app-smoke.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

if [ ! -x "$app/Contents/MacOS/SoloTrace" ]; then
  echo "Build the app first with mise run package-macos." >&2
  exit 1
fi

SOLOTRACE_DATA_DIR="$scratch/data" \
SOLOTRACE_LOG_DIR="$scratch/logs" \
SOLOTRACE_DISABLE_KEYCHAIN=1 \
"$app/Contents/MacOS/SoloTrace" --self-test
echo "SoloTrace.app self-test passed"
