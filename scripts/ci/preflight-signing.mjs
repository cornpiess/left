#!/usr/bin/env node
/**
 * Pre-build signing credential gate (v296 iron rule 1 — see AGENTS.md).
 *
 * A revoked distribution certificate only surfaces ~3 minutes into an
 * xcodebuild archive with a cryptic signing error. This gate fails in
 * seconds instead: before any expensive step runs, verify that the
 * certificate bundled in the repository secrets is still ALIVE on the
 * Apple side, that the provisioning profile embeds that same
 * certificate, and that the profile has not expired.
 *
 * Env:
 *   APPLE_CERT_P12_BASE64         base64 of the Apple Distribution .p12
 *   APPLE_CERT_PASSWORD           password of that .p12
 *   APPLE_PROVISION_PROFILE_BASE64  base64 of the App Store .mobileprovision
 *   ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8_BASE64  ASC API key
 * Exit 0 = credentials live and consistent; exit 1 = run the self-heal
 * script first, do NOT start the build.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildAscJwt } from './asc-next-build-number.mjs';

/** Uppercase hex, no separators, no insignificant leading zeros — openssl
 * pads serials to even length (04783…), Apple's API does not (4783…). */
export function normalizeSerial(s) {
  return String(s || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().replace(/^0+(?=.)/, '');
}

/**
 * Apple plist decodes with stray \r\r\n line endings; tolerate any
 * whitespace BETWEEN tags (Apple uses \r\r\n / tabs for indentation)
 * while keeping the value itself byte-exact.
 */
export function extractPlistValue(plistText, key, tag) {
  const m = String(plistText).match(new RegExp(`<key>${key}</key>\\s*<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

/** First <data> blob after the DeveloperCertificates key (the signing cert). */
export function firstDeveloperCertificateB64(plistText) {
  const m = String(plistText).match(/<key>DeveloperCertificates<\/key>\s*<array>\s*<data>([^<]*)<\/data>/);
  return m ? m[1] : null;
}

/**
 * Pure verdict over the collected facts. `appleSerials` is the live
 * distribution-certificate serial list from the App Store Connect API —
 * revoked certificates disappear from that list entirely, so presence
 * is the liveness proof.
 */
export function verifyPreflight({ p12Serial, profileSerial, profileExpiryIso, appleSerials, now = new Date() }) {
  const reasons = [];
  const serials = (appleSerials || []).map(normalizeSerial);
  if (!p12Serial) reasons.push('could not read the certificate serial from the .p12');
  if (p12Serial && !serials.includes(normalizeSerial(p12Serial))) {
    reasons.push(
      `certificate ${normalizeSerial(p12Serial)} is NOT in the live Apple certificate list — it was revoked or replaced. ` +
        'Run the self-heal script and update the repository secrets before building.'
    );
  }
  if (!profileSerial) {
    reasons.push('could not read the certificate serial embedded in the provisioning profile');
  } else if (p12Serial && normalizeSerial(profileSerial) !== normalizeSerial(p12Serial)) {
    reasons.push(
      `profile embeds certificate ${normalizeSerial(profileSerial)} but the .p12 is ${normalizeSerial(p12Serial)} — ` +
        'secrets are from different credential generations; regenerate the pair together.'
    );
  }
  const expiry = profileExpiryIso ? Date.parse(profileExpiryIso) : NaN;
  if (!Number.isFinite(expiry)) {
    reasons.push('could not read the profile expiration date');
  } else if (expiry <= now.getTime()) {
    reasons.push(`profile expired at ${profileExpiryIso}`);
  }
  return { ok: reasons.length === 0, reasons };
}

async function fetchLiveDistributionCertificates(jwt) {
  // The unfiltered endpoint lists DEVELOPMENT certificates too; only the
  // *DISTRIBUTION family can sign an App Store archive, so keep those.
  const certs = [];
  let url = 'https://api.appstoreconnect.apple.com/v1/certificates?limit=200';
  for (let page = 0; page < 5 && url; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
    if (!res.ok) throw new Error(`ASC certificates HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const c of body.data || []) {
      const a = c.attributes || {};
      if (String(a.certificateType || '').includes('DISTRIBUTION')) certs.push(a);
    }
    url = (body.links && body.links.next) || null;
  }
  return certs;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

async function main() {
  const env = process.env;
  const missing = ['APPLE_CERT_P12_BASE64', 'APPLE_CERT_PASSWORD', 'APPLE_PROVISION_PROFILE_BASE64', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_BASE64']
    .filter((k) => !env[k]);
  if (missing.length) throw new Error('missing env: ' + missing.join(', '));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-preflight-'));
  const p12Path = path.join(tmp, 'cert.p12');
  const profilePath = path.join(tmp, 'profile.mobileprovision');
  fs.writeFileSync(p12Path, Buffer.from(env.APPLE_CERT_P12_BASE64.replace(/\s/g, ''), 'base64'));
  fs.writeFileSync(profilePath, Buffer.from(env.APPLE_PROVISION_PROFILE_BASE64.replace(/\s/g, ''), 'base64'));

  // Password proves the p12 is intact; the cert PEM feeds the serial read.
  run('openssl', ['pkcs12', '-in', p12Path, '-passin', `pass:${env.APPLE_CERT_PASSWORD}`, '-nokeys', '-out', path.join(tmp, 'cert.pem')]);
  const serialOut = run('openssl', ['x509', '-in', path.join(tmp, 'cert.pem'), '-noout', '-serial']);
  const p12Serial = normalizeSerial((serialOut.match(/serial=([0-9A-Fa-f:]+)/) || [])[1]);

  // Profiles are CMS (DER) envelopes; -noverify skips Apple's chain and just unwraps.
  run('openssl', ['smime', '-verify', '-noverify', '-inform', 'DER', '-in', profilePath, '-out', path.join(tmp, 'profile.plist')]);
  const plist = fs.readFileSync(path.join(tmp, 'profile.plist'), 'utf8');
  const profileName = extractPlistValue(plist, 'Name', 'string');
  const profileExpiryIso = extractPlistValue(plist, 'ExpirationDate', 'date');
  const profileSerial = (() => {
    const certB64 = firstDeveloperCertificateB64(plist);
    if (!certB64) return '';
    const der = path.join(tmp, 'profile-cert.der');
    fs.writeFileSync(der, Buffer.from(certB64, 'base64'));
    const out = run('openssl', ['x509', '-inform', 'DER', '-in', der, '-noout', '-serial']);
    return normalizeSerial((out.match(/serial=([0-9A-Fa-f:]+)/) || [])[1]);
  })();

  const keyPem = Buffer.from(env.ASC_KEY_P8_BASE64.replace(/\s/g, ''), 'base64').toString('utf8');
  const jwt = buildAscJwt({ keyPem, keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID });
  const appleCerts = await fetchLiveDistributionCertificates(jwt);
  const appleSerials = appleCerts.map((a) => a.serialNumber);

  const verdict = verifyPreflight({ p12Serial, profileSerial, profileExpiryIso, appleSerials });
  console.log(`preflight: p12 serial ${p12Serial || '?'}`);
  console.log(`preflight: profile "${profileName}" embeds ${profileSerial || '?'} (expires ${profileExpiryIso || '?'})`);
  console.log(`preflight: live Apple distribution certificates: ${appleCerts.map((a) => `${normalizeSerial(a.serialNumber)} [${a.certificateType}]`).join(', ') || '(none)'}`);
  if (!verdict.ok) {
    for (const r of verdict.reasons) console.error(`PREFLIGHT FAILED: ${r}`);
    process.exitCode = 1;
    return;
  }
  console.log('preflight: signing credentials are LIVE and consistent — safe to build.');
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => {
    console.error('PREFLIGHT FAILED: ' + String(e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}
