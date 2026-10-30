#!/bin/bash
# Upload an IPA to TestFlight via fastlane pilot using an ASC API key.
# Args: $1 = path to .ipa
# Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64
set -euo pipefail

IPA="${1:?usage: upload-testflight.sh <path-to-ipa>}"
[ -f "$IPA" ] || { echo "ERROR: IPA not found: $IPA" >&2; exit 1; }

# fastlane's api_key JSON requires the p8 CONTENT inline under "key"
# (key_id/issuer_id alone are rejected: "missing field(s): key").
KEY_CONTENT="$(printf '%s' "$ASC_KEY_P8_BASE64" | openssl base64 -d -A)"
jq -n \
  --arg key "$KEY_CONTENT" \
  --arg kid "$ASC_KEY_ID" \
  --arg iss "$ASC_ISSUER_ID" \
  '{key_id: $kid, issuer_id: $iss, key: $key, in_house: false}' > asc_api_key.json

if ! command -v fastlane >/dev/null 2>&1; then
  echo "fastlane not found, installing..." >&2
  sudo gem install fastlane --no-document
fi

# Upload acceptance is verified here; Apple-side processing happens after the
# upload and is monitored in App Store Connect (same as EAS submit behavior).
fastlane pilot upload \
  --ipa "$IPA" \
  --api_key_path asc_api_key.json \
  --skip_waiting_for_build_processing

rm -f asc_api_key.json
echo "Uploaded to App Store Connect — watch processing at https://appstoreconnect.apple.com" >&2
