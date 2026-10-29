#!/bin/bash
# Import Apple signing materials into a dedicated macOS keychain.
# Env: APPLE_CERT_P12_BASE64, APPLE_CERT_PASSWORD, APPLE_PROVISION_PROFILE_BASE64
# Outputs (GITHUB_OUTPUT when present, else stdout export lines):
#   profile_name, team_id, bundle_id, keychain_name
set -euo pipefail

KEYCHAIN="ci-build.keychain"
KEYCHAIN_PW="$(openssl rand -hex 16)"

# --- keychain with the distribution certificate -----------------------------
security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"

printf '%s' "$APPLE_CERT_P12_BASE64" | openssl base64 -d -A -out cert.p12
security import cert.p12 \
  -k "$KEYCHAIN" \
  -P "$APPLE_CERT_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/xcodebuild -T /usr/bin/security
security list-keychain -d user -s "$KEYCHAIN" login.keychain-db
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null

# Distribution certs come in two generations: "Apple Distribution" (unified)
# and the older "iPhone Distribution" — accept either and pass the actual
# identity name through to the build step.
IDENTITY_NAME="$(security find-identity -v -p codesigning "$KEYCHAIN" \
  | grep -m1 -oE '"(Apple|iPhone) Distribution: [^"]+"' \
  | sed 's/^"//; s/"$//' || true)"
if [ -z "$IDENTITY_NAME" ]; then
  echo "ERROR: no distribution codesigning identity found after import" >&2
  security find-identity -v -p codesigning "$KEYCHAIN" >&2 || true
  exit 1
fi

# --- provisioning profile -----------------------------------------------------
printf '%s' "$APPLE_PROVISION_PROFILE_BASE64" | openssl base64 -d -A -out app.mobileprovision
PLIST="$(security cms -D -i app.mobileprovision)"

PROFILE_NAME="$(printf '%s' "$PLIST" | /usr/libexec/PlistBuddy -c 'Print Name' /dev/stdin)"
TEAM_ID="$(printf '%s' "$PLIST" | /usr/libexec/PlistBuddy -c 'Print TeamIdentifier:0' /dev/stdin)"
APP_ID="$(printf '%s' "$PLIST" | /usr/libexec/PlistBuddy -c 'Print Entitlements:application-identifier' /dev/stdin)"
BUNDLE_ID="${APP_ID#"$TEAM_ID".}"
UUID="$(printf '%s' "$PLIST" | /usr/libexec/PlistBuddy -c 'Print UUID' /dev/stdin)"

PROFILES_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILES_DIR"
cp app.mobileprovision "$PROFILES_DIR/$UUID.mobileprovision"

# --- publish step outputs -----------------------------------------------------
emit() { echo "$1"; if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >> "$GITHUB_OUTPUT"; fi; }
emit "profile_name=$PROFILE_NAME"
emit "team_id=$TEAM_ID"
emit "bundle_id=$BUNDLE_ID"
emit "signing_identity=$IDENTITY_NAME"
emit "keychain_name=$KEYCHAIN"

echo "Signing ready: identity '$IDENTITY_NAME' profile '$PROFILE_NAME' team $TEAM_ID bundle $BUNDLE_ID" >&2
