#!/bin/sh
set -eu

app=${1:?usage: sign-macos-app.sh APP IDENTITY ENTITLEMENTS}
identity=${2:?usage: sign-macos-app.sh APP IDENTITY ENTITLEMENTS}
entitlements=${3:?usage: sign-macos-app.sh APP IDENTITY ENTITLEMENTS}

sign() {
  if [ "$identity" = "-" ]; then
    codesign --force --options runtime --sign "$identity" "$@"
  else
    codesign --force --options runtime --timestamp --sign "$identity" "$@"
  fi
}

find "$app/Contents/Frameworks" -type f -print |
while IFS= read -r candidate; do
  if file "$candidate" | grep -q "Mach-O"; then
    sign "$candidate"
  fi
done

for tool in \
  "$app/Contents/Resources/youtube/bin/yt-dlp" \
  "$app/Contents/Resources/youtube/bin/deno"
do
  if [ -f "$tool" ]; then
    sign --entitlements "$entitlements" "$tool"
  fi
done

sign --entitlements "$entitlements" "$app/Contents/MacOS/SoloTrace"
sign --entitlements "$entitlements" "$app"
