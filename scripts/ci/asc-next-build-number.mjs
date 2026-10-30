#!/usr/bin/env node
/**
 * Resolve the next iOS build number from App Store Connect.
 *
 * Queries every build record for the app and returns max(version)+1. Apple
 * permanently rejects reused build numbers within a version train, so when
 * ASC cannot be reached and no --override was given we fail loudly instead
 * of guessing (a wrong guess burns a submission).
 *
 * Env:
 *   ASC_KEY_ID        App Store Connect API key id
 *   ASC_ISSUER_ID     App Store Connect API issuer id
 *   ASC_KEY_P8_BASE64 base64 of the .p8 key file
 * Args:
 *   --app-id <id>   ASC app id (default: the shipping LeftSwipe app)
 *   --override <n>  use this number directly; skips the ASC query entirely
 * Prints the resolved number (integer) to stdout.
 */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ASC_APP_ID = '6804368763';

/** max(existing)+1, never below floor+1. Pure — unit-tested. */
export function nextBuildNumber(existing, floor = 0) {
  let max = floor;
  for (const v of existing) {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * ES256 JWT for the App Store Connect API. The aud claim is required —
 * tokens without it are rejected with 401 NOT_AUTHORIZED even when the
 * signature is valid.
 */
export function buildAscJwt({ keyPem, keyId, issuerId, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = 1100 }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: issuerId, iat: nowSeconds, exp: nowSeconds + ttlSeconds, aud: 'appstoreconnect-v1' })
  );
  const key = crypto.createPrivateKey(keyPem);
  // ieee-p1363 emits the raw r||s JOSE signature directly (no ASN.1 DER wrapper)
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + payload), { key, dsaEncoding: 'ieee-p1363' });
  return header + '.' + payload + '.' + b64url(sig);
}

async function fetchAllBuildVersions(jwt, appId) {
  const versions = [];
  let url =
    `https://api.appstoreconnect.apple.com/v1/builds?filter[app]=${appId}` +
    `&fields[builds]=version&limit=200`;
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
    if (!res.ok) throw new Error(`ASC HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const b of body.data || []) versions.push(b.attributes && b.attributes.version);
    url = (body.links && body.links.next) || null;
  }
  return versions;
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const override = argOf('--override');
  if (override !== undefined && String(override).trim() !== '') {
    const n = parseInt(String(override), 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --override: ${override}`);
    console.log(n);
    return;
  }

  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64 } = process.env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_P8_BASE64) {
    throw new Error('missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8_BASE64 env');
  }
  const keyPem = Buffer.from(ASC_KEY_P8_BASE64.replace(/\s/g, ''), 'base64').toString('utf8');
  const jwt = buildAscJwt({ keyPem, keyId: ASC_KEY_ID, issuerId: ASC_ISSUER_ID });
  const appId = argOf('--app-id') || DEFAULT_ASC_APP_ID;
  const versions = await fetchAllBuildVersions(jwt, appId);
  console.log(nextBuildNumber(versions));
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  });
}
