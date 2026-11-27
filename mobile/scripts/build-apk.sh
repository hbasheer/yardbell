#!/bin/bash
# Build the signed Yardbell phone app apk and name it like the releases expect.
# Usage: build-apk.sh [--upload]
#   --upload attaches the apk to the GitHub release of the current version (gh must be signed in).
# Signing is wired in by plugins/withReleaseSigning.js from ~/.local/android/release/keystore.properties
# (or the file named by YARDBELL_KEYSTORE_PROPERTIES).
set -euo pipefail
A=$HOME/.local/android
export JAVA_HOME=$A/jdk ANDROID_HOME=$A/sdk
NDK=$(ls -d "$A"/sdk/ndk/* | sort -V | tail -1)
export ANDROID_NDK_ROOT=$NDK PATH="$A/jdk/bin:$PATH"

cd "$(dirname "$0")/.."
version=$(awk '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version *=/{gsub(/"/,"",$3); print $3; exit}' ../Cargo.toml)

node scripts/build-terminal.mjs
npx expo prebuild --platform android --clean
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a)

out="$PWD/Yardbell_${version}_android.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$out"
echo "apk: $out"

if [ "${1:-}" = "--upload" ]; then
  gh release upload "v$version" "$out" --clobber
  echo "uploaded to release v$version"
fi
