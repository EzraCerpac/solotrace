#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=8.1.2
sha256=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
work="$root/build/ffmpeg-$version"
archive="$root/build/ffmpeg-$version.tar.xz"
source_dir="$work/source"
target="$root/vendor/ffmpeg"

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "FFmpeg bundle must be built on Apple Silicon macOS." >&2
  exit 1
fi

if [ -x "$target/bin/ffmpeg" ] && [ -x "$target/bin/ffprobe" ]; then
  buildconf=$("$target/bin/ffmpeg" -buildconf 2>&1)
  case "$buildconf" in
    *--enable-gpl*|*--enable-nonfree*)
      echo "Refusing non-LGPL FFmpeg bundle." >&2
      exit 1
      ;;
  esac
  exit 0
fi

mkdir -p "$root/build"
if [ ! -f "$archive" ]; then
  curl --fail --location --silent --show-error \
    "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz" \
    --output "$archive"
fi
actual=$(shasum -a 256 "$archive" | awk '{print $1}')
if [ "$actual" != "$sha256" ]; then
  echo "FFmpeg source checksum mismatch." >&2
  exit 1
fi

rm -rf "$work" "$target"
mkdir -p "$source_dir" "$target"
tar -xf "$archive" -C "$source_dir" --strip-components=1

cd "$source_dir"
./configure \
  --prefix="$target" \
  --arch=arm64 \
  --target-os=darwin \
  --cc=clang \
  --disable-autodetect \
  --disable-debug \
  --disable-doc \
  --disable-gpl \
  --disable-network \
  --disable-nonfree \
  --disable-programs \
  --disable-shared \
  --enable-ffmpeg \
  --enable-ffprobe \
  --enable-static \
  --disable-encoders \
  --enable-encoder=pcm_s16le \
  --disable-muxers \
  --enable-muxer=wav
make -j "$(sysctl -n hw.ncpu)"
make install

mkdir -p "$target/LICENSE"
cp COPYING.LGPLv2.1 "$target/LICENSE/FFmpeg-LGPL-2.1.txt"
"$target/bin/ffmpeg" -buildconf > "$target/LICENSE/build-configuration.txt" 2>&1

buildconf=$("$target/bin/ffmpeg" -buildconf 2>&1)
case "$buildconf" in
  *--enable-gpl*|*--enable-nonfree*)
    echo "Built FFmpeg is not LGPL-only." >&2
    exit 1
    ;;
esac
file "$target/bin/ffmpeg" | grep -q "arm64"
file "$target/bin/ffprobe" | grep -q "arm64"
