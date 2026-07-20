#!/bin/sh
set -eu

app=${1:?usage: sign-macos-app.sh APP IDENTITY ENTITLEMENTS}
identity=${2:?usage: sign-macos-app.sh APP IDENTITY ENTITLEMENTS}
entitlements=${3:?usage: sign-macos-app.sh APP IDENTITY ENTITLEMENTS}

find "$app/Contents/Frameworks" -type f -print |
while IFS= read -r candidate; do
  if file "$candidate" | grep -q "Mach-O"; then
    codesign --force --options runtime --timestamp \
      --sign "$identity" "$candidate"
  fi
done

codesign --force --options runtime --timestamp \
  --entitlements "$entitlements" \
  --sign "$identity" "$app/Contents/MacOS/SoloTrace"
codesign --force --options runtime --timestamp \
  --entitlements "$entitlements" \
  --sign "$identity" "$app"
