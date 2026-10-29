#!/bin/bash
# Generate the native iOS project, archive it and export an App Store IPA.
# Env: PROFILE_NAME, TEAM_ID, BUNDLE_ID, SIGNING_IDENTITY (from import-ios-signing.sh).
# Produces build/ipa/*.ipa. Requires the JS deps installed beforehand.
set -euo pipefail

SIGNING_IDENTITY="${SIGNING_IDENTITY:-Apple Distribution}"

# --- native project (this repo uses Expo CNG: no committed ios/ dir) ----------
npx expo prebuild --platform ios --no-install
( cd ios && pod install )

# NOTE: never use `ls ios/*.xcworkspace` here — ls of a single directory
# prints the directory's CONTENTS ("contents.xcworkspacedata"), not its path.
WORKSPACE=""
for candidate in ios/*.xcworkspace; do
  if [ -e "$candidate" ]; then
    WORKSPACE="$candidate"
    break
  fi
done
if [ -z "$WORKSPACE" ]; then
  echo "ERROR: no xcworkspace found after prebuild" >&2
  ls -la ios/ >&2 || true
  exit 1
fi
# The scheme MUST be the app itself. xcodebuild -list puts auto-generated pod
# schemes (e.g. EXConstants) first — archiving those "succeeds" yet produces
# an archive with no .app. Prefer the scheme named after the workspace.
APP_SCHEME_GUESS="$(basename "$WORKSPACE" .xcworkspace)"
LIST_OUT="$(xcodebuild -list -workspace "$WORKSPACE" 2>/dev/null || true)"
SCHEME="$(printf '%s\n' "$LIST_OUT" | sed -n '/Schemes:/,$p' | sed 1d | grep -xF "$APP_SCHEME_GUESS" || true)"
if [ -z "$SCHEME" ]; then
  SCHEME="$APP_SCHEME_GUESS"
  echo "NOTE: scheme '$APP_SCHEME_GUESS' not in -list output, using workspace name" >&2
fi
echo "Building scheme '$SCHEME' from $WORKSPACE" >&2

mkdir -p build

xcodebuild archive \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/App.xcarchive \
  CODE_SIGN_STYLE=Manual \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_IDENTITY="$SIGNING_IDENTITY"

# Package the signed archive into an IPA directly. We deliberately avoid
# `xcodebuild -exportArchive`: on Xcode 26 its distribution-method manager
# contacts App Store Connect while enumerating methods and fails opaquely
# ("Unknown Distribution Error", empty allowed-method set) while program
# agreements are unsigned — even though the archive is fully signed with an
# App Store profile. A Payload zip of the archived .app is equivalent for
# TestFlight upload.
# Archive layouts vary across Xcode versions; search the whole bundle.
ALL_APPS="$(find build/App.xcarchive -type d -name '*.app' 2>/dev/null || true)"
APP_PATH="${ALL_APPS%%$'\n'*}"
if [ -z "$APP_PATH" ]; then
  echo "ERROR: no .app found in the archive; layout dump follows:" >&2
  find build -maxdepth 5 2>/dev/null | head -60 >&2 || true
  exit 1
fi

mkdir -p build/ipa/Payload
cp -R "$APP_PATH" build/ipa/Payload/
( cd build/ipa && zip -qry release.ipa Payload )
rm -rf build/ipa/Payload

IPA="build/ipa/release.ipa"
# Apple rejects reused build numbers; surface which one this IPA carries.
BUILT_NUM="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Info.plist" || true)"
echo "IPA ready: $IPA (CFBundleVersion=$BUILT_NUM)" >&2
