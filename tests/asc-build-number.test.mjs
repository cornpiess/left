import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { nextBuildNumber, buildAscJwt } from '../scripts/ci/asc-next-build-number.mjs';

test('next build number is max(existing)+1 across version trains', () => {
  assert.equal(nextBuildNumber(['58', '57', '44', '46']), 59);
  assert.equal(nextBuildNumber(['99']), 100);
});

test('next build number tolerates non-numeric junk from ASC paging', () => {
  assert.equal(nextBuildNumber([undefined, null, '', 'oops', '12']), 13);
});

test('empty ASC history yields floor+1 instead of 1', () => {
  assert.equal(nextBuildNumber([], 43), 44);
  assert.equal(nextBuildNumber([], 0), 1);
});

test('ASC JWT carries the required aud claim and ES256 header', () => {
  // A throwaway P-256 key so this test never touches real credentials.
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = privateKey.export({ type: 'sec1', format: 'pem' });
  const jwt = buildAscJwt({ keyPem, keyId: 'TESTKEY', issuerId: 'iss-uuid', nowSeconds: 1000, ttlSeconds: 1100 });
  const [h, p] = jwt.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
  assert.equal(h.alg, 'ES256');
  assert.equal(h.kid, 'TESTKEY');
  assert.equal(p.iss, 'iss-uuid');
  assert.equal(p.aud, 'appstoreconnect-v1');
  assert.equal(p.iat, 1000);
  assert.equal(p.exp, 2100);
});
