#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ytdlp_version=2026.07.04
ytdlp_sha256=498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b
deno_version=2.9.4
deno_sha256=6d17647fdbf9c587a581dba205054c4ccf732dae0a196cc1e9b44c07589db412
ytdlp_license_sha256=7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c
deno_license_sha256=f62497fffecc0852960c8d3e6934b9db86d16396e9b604072e923892cae3a588
build="$root/build/youtube-tools"
target="$root/vendor/youtube"
ytdlp_archive="$build/yt-dlp_macos-$ytdlp_version"
deno_archive="$build/deno-aarch64-apple-darwin-$deno_version.zip"

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "YouTube tools must be bundled on Apple Silicon macOS." >&2
  exit 1
fi

if [ -x "$target/bin/yt-dlp" ] && [ -x "$target/bin/deno" ]; then
  test "$("$target/bin/yt-dlp" --version)" = "$ytdlp_version"
  "$target/bin/deno" --version | grep -q "deno $deno_version"
  exit 0
fi

mkdir -p "$build"
if [ ! -f "$ytdlp_archive" ]; then
  curl --fail --location --silent --show-error \
    "https://github.com/yt-dlp/yt-dlp/releases/download/$ytdlp_version/yt-dlp_macos" \
    --output "$ytdlp_archive"
fi
if [ ! -f "$deno_archive" ]; then
  curl --fail --location --silent --show-error \
    "https://github.com/denoland/deno/releases/download/v$deno_version/deno-aarch64-apple-darwin.zip" \
    --output "$deno_archive"
fi

test "$(shasum -a 256 "$ytdlp_archive" | awk '{print $1}')" = "$ytdlp_sha256"
test "$(shasum -a 256 "$deno_archive" | awk '{print $1}')" = "$deno_sha256"

rm -rf "$target"
mkdir -p "$target/bin" "$target/LICENSE"
cp "$ytdlp_archive" "$target/bin/yt-dlp"
unzip -q "$deno_archive" deno -d "$target/bin"
chmod 755 "$target/bin/yt-dlp" "$target/bin/deno"

curl --fail --location --silent --show-error \
  "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$ytdlp_version/LICENSE" \
  --output "$target/LICENSE/yt-dlp-UNLICENSE.txt"
curl --fail --location --silent --show-error \
  "https://raw.githubusercontent.com/denoland/deno/v$deno_version/LICENSE.md" \
  --output "$target/LICENSE/Deno-MIT.txt"
test "$(shasum -a 256 "$target/LICENSE/yt-dlp-UNLICENSE.txt" | awk '{print $1}')" = \
  "$ytdlp_license_sha256"
test "$(shasum -a 256 "$target/LICENSE/Deno-MIT.txt" | awk '{print $1}')" = \
  "$deno_license_sha256"

test "$("$target/bin/yt-dlp" --version)" = "$ytdlp_version"
"$target/bin/deno" --version | grep -q "deno $deno_version"
file "$target/bin/yt-dlp" | grep -q "arm64"
file "$target/bin/deno" | grep -q "arm64"
