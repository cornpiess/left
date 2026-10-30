import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSerial, extractPlistValue, firstDeveloperCertificateB64, verifyPreflight } from '../scripts/ci/preflight-signing.mjs';

const LIVE_SERIAL = '47839BEDAB9671A5910523F971C6CB8';
const NOW = new Date('2026-10-30T04:00:00Z');
const GOOD = {
  p12Serial: LIVE_SERIAL,
  profileSerial: '47839bedab9671a5910523f971c6cb8', // lowercase — normalization must absorb it
  profileExpiryIso: '2027-10-28T06:08:53Z',
  appleSerials: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '4783:9BED:AB96:71A5:9105:23F9:71C6:CB8'.replace(/:/g, '')],
  now: NOW,
};

test('normalizeSerial strips separators, case, and openssl leading zeros', () => {
  assert.equal(normalizeSerial('4783:9BED:ab96'), '47839BEDAB96');
  assert.equal(normalizeSerial('047839BEDAB9671A5'), '47839BEDAB9671A5'); // openssl pads; Apple does not
  assert.equal(normalizeSerial(null), '');
});

test('extractPlistValue survives the \\r\\r\\n line endings Apple ships in profiles', () => {
  const plist = '<?xml version="1.0"?>\r<plist><dict>\r\r\n\t<key>Name</key>\r\r\n\t<string>maoqiu appstore 20261030025754</string>\r\r\n' +
    '\t<key>ExpirationDate</key>\r\r\n\t<date>2027-10-28T06:08:53Z</date>\r\r\n</dict></plist>';
  assert.equal(extractPlistValue(plist, 'Name', 'string'), 'maoqiu appstore 20261030025754');
  assert.equal(extractPlistValue(plist, 'ExpirationDate', 'date'), '2027-10-28T06:08:53Z');
  assert.equal(extractPlistValue(plist, 'Missing', 'string'), null);
});

test('firstDeveloperCertificateB64 grabs the first data blob of the cert array', () => {
  const plist = '<dict><key>DeveloperCertificates</key><array><data>AAECAw==</data><data>BBBDDD==</data></array></dict>';
  assert.equal(firstDeveloperCertificateB64(plist), 'AAECAw==');
  assert.equal(firstDeveloperCertificateB64('<dict><key>Other</key><array/></dict>'), null);
});

test('verifyPreflight passes on live, matched, unexpired credentials', () => {
  assert.deepEqual(verifyPreflight(GOOD), { ok: true, reasons: [] });
});

test('verifyPreflight fails when the certificate vanished from the Apple list (revoked)', () => {
  const v = verifyPreflight({ ...GOOD, appleSerials: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /NOT in the live Apple certificate list/);
});

test('verifyPreflight fails when profile and p12 come from different credential generations', () => {
  const v = verifyPreflight({ ...GOOD, profileSerial: '3C586ECC455E0398C5A3A3B7FC10D9E1' });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /different credential generations/);
});

test('verifyPreflight fails on an expired profile', () => {
  const v = verifyPreflight({ ...GOOD, profileExpiryIso: '2026-10-01T00:00:00Z' });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /profile expired/);
});
