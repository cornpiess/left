import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_FREE_LIMIT,
  IAP_REQUEST_TIMEOUT_MS,
  IAP_RETRY_DELAYS_MS,
  IAP_SKUS,
  getPlanTypeForProductId,
  getProductDisplayPrice,
  indexIapProducts,
  resolveCatalogStatus,
  resolveEntitlement,
} from '../src/membershipCore.mjs';

test('uses the product shape returned by react-native-iap v16', () => {
  const products = [
    { id: IAP_SKUS.YEARLY, displayPrice: '¥28.00' },
    { id: IAP_SKUS.LIFETIME, displayPrice: '¥98.00' },
  ];
  const indexed = indexIapProducts(products);

  assert.equal(indexed[IAP_SKUS.YEARLY], products[0]);
  assert.equal(indexed[IAP_SKUS.LIFETIME], products[1]);
  assert.equal(getProductDisplayPrice(products[0], 'fallback'), '¥28.00');
});

test('only known StoreKit products can unlock an entitlement', () => {
  assert.equal(getPlanTypeForProductId(IAP_SKUS.YEARLY), 'yearly');
  assert.equal(getPlanTypeForProductId(IAP_SKUS.LIFETIME), 'lifetime');
  assert.equal(getPlanTypeForProductId('com.example.unknown'), null);
});

test('restore chooses lifetime over yearly and ignores unrelated purchases', () => {
  assert.equal(resolveEntitlement([
    { id: 'transaction-1', productId: IAP_SKUS.YEARLY },
    { id: 'transaction-2', productId: IAP_SKUS.LIFETIME },
  ]), 'lifetime');
  assert.equal(resolveEntitlement([{ productId: 'com.example.unknown' }]), null);
});

test('free quota matches the product requirement', () => {
  assert.equal(DAILY_FREE_LIMIT, 100);
});

test('partial StoreKit catalog degrades instead of failing the whole paywall', () => {
  assert.equal(resolveCatalogStatus({ [IAP_SKUS.YEARLY]: {}, [IAP_SKUS.LIFETIME]: {} }), 'ready');
  assert.equal(resolveCatalogStatus({ [IAP_SKUS.YEARLY]: {} }), 'partial');
  assert.equal(resolveCatalogStatus({ [IAP_SKUS.LIFETIME]: {} }), 'partial');
  assert.equal(resolveCatalogStatus({}), 'error');
  assert.equal(resolveCatalogStatus(null), 'error');
});

test('StoreKit catalog fetches use a bounded timeout and automatic retries', () => {
  assert.ok(IAP_REQUEST_TIMEOUT_MS >= 5000, 'timeout must be at least 5s for slow sandbox responses');
  assert.ok(IAP_RETRY_DELAYS_MS.length >= 2, 'fetch must auto-retry at least twice before surfacing an error');
  for (const delay of IAP_RETRY_DELAYS_MS) {
    assert.ok(Number.isInteger(delay) && delay > 0 && delay <= 10000);
  }
});

test('paywall price text falls back to configured plan prices when products are unavailable', async () => {
  const { readFile } = await import('node:fs/promises');
  const paywall = await readFile(new URL('../src/components/PaywallModal.js', import.meta.url), 'utf8');

  assert.match(paywall, /PRICING_PLANS\.YEARLY\.title/);
  assert.match(paywall, /PRICING_PLANS\.LIFETIME\.title/);
  assert.doesNotMatch(paywall, /getProductDisplayPrice\([^)]*t\('common\.loading'\)/);
});
