import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchPromotionConfig, formatPromotionMoney, nextPromotionBoundary, PROMOTIONS_MAX_AGE_MS, resolveLifetimePromotion, validatePromotionConfig } from '../src/promotions.mjs';

const now = Date.parse('2026-11-05T08:00:00Z');
const config = { version: 1, lifetime: {
  CHN: { currency: 'CNY', regularPrice: 98, salePrice: 78 },
  USA: { currency: 'USD', regularPrice: 14.99, salePrice: 9.99 },
  JPN: { currency: 'JPY', regularPrice: 2200, salePrice: 1500 },
  KWT: { currency: 'KWD', regularPrice: 4.999, salePrice: 3.499 },
} };
const resolve = (overrides = {}) => resolveLifetimePromotion({ config, storefront: 'CHN', product: { price: 78, currency: 'CNY', displayPrice: '¥78.00' }, receivedAt: now, now, ...overrides });
const response = value => ({ ok: true, text: async () => JSON.stringify(value) });

test('the editable configuration follows the same schema as the app', () => {
  const shipped = JSON.parse(readFileSync(new URL('../config/promotions.json', import.meta.url), 'utf8'));
  assert.deepEqual(validatePromotionConfig(shipped), []);
});

test('each storefront requires its own currency and actual Apple sale price', () => {
  assert.equal(resolve().savings, 20);
  assert.equal(resolve({ storefront: 'USA', product: { price: 9.99, currency: 'USD', displayPrice: '$9.99' } }).savings, 5);
  assert.equal(resolve({ storefront: 'JPN', product: { price: 1500, currency: 'JPY', displayPrice: '¥1,500' } }).savings, 700);
  assert.ok(Math.abs(resolve({ storefront: 'KWT', product: { price: 3.499, currency: 'KWD', displayPrice: 'KWD 3.499' } }).savings - 1.5) < 0.000001);
  // A currency shared by multiple regions never acts as a storefront fallback.
  for (const overrides of [
    { storefront: 'SGP' }, { storefront: '' }, { storefront: null },
    { product: { price: 98, currency: 'CNY', displayPrice: '¥98' } },
    { product: { price: 68, currency: 'CNY', displayPrice: '¥68' } },
    { product: { price: 78, currency: 'JPY', displayPrice: '¥78' } },
    { product: { price: '78', currency: 'CNY', displayPrice: '¥78' } },
    { product: undefined }, { product: { price: 78, currency: 'CNY' } },
    { config: { version: 1, lifetime: {} } },
  ]) assert.equal(resolve(overrides), null, JSON.stringify(overrides));
});

test('expired, future, missing and stale contexts never advertise a promotion', () => {
  assert.equal(resolve({ receivedAt: now - PROMOTIONS_MAX_AGE_MS }), null);
  assert.equal(resolve({ receivedAt: now + 1 }), null);
  assert.equal(resolve({ receivedAt: undefined }), null);
  assert.ok(resolve({ receivedAt: now - PROMOTIONS_MAX_AGE_MS + 1 }));
  const scheduled = { version: 1, lifetime: { CHN: { ...config.lifetime.CHN, startsAt: '2026-11-05T16:00:00+08:00', endsAt: '2026-11-05T16:01:00+08:00' } } };
  assert.equal(resolve({ config: scheduled, now: now - 1, receivedAt: now - 1 }), null);
  assert.ok(resolve({ config: scheduled }));
  assert.equal(resolve({ config: scheduled, now: now + 60000 }), null);
  assert.equal(nextPromotionBoundary(scheduled, now, now), now + 60000);
  assert.equal(nextPromotionBoundary(config, now, now), now + PROMOTIONS_MAX_AGE_MS);
  assert.equal(nextPromotionBoundary(config, undefined, now), null);
});

test('config validation rejects typos, invalid discounts and ambiguous dates', () => {
  for (const value of [null, [], {}, { ...config, version: 2 }, { ...config, lifetme: {} },
    ...[
      { currency: 'cny', regularPrice: 98, salePrice: 78 },
      { currency: 'CNY', regularPrice: '98', salePrice: 78 },
      { currency: 'CNY', regularPrice: 78, salePrice: 98 },
      { currency: 'CNY', regularPrice: 98, salePrice: 0 },
      { ...config.lifetime.CHN, saleprice: 68 },
      { ...config.lifetime.CHN, endsAt: '2026-11-05' },
      { ...config.lifetime.CHN, startsAt: '2026-11-06T00:00:00Z', endsAt: '2026-11-05T00:00:00Z' },
    ].map(offer => ({ version: 1, lifetime: { CHN: offer } })),
    { version: 1, lifetime: { CN: config.lifetime.CHN } },
  ]) assert.ok(validatePromotionConfig(value).length, JSON.stringify(value));
});

test('derived money uses the selected language and actual currency decimal precision', () => {
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'es', 'ja', 'ko']) {
    for (const [currency, amount] of [['CNY', 98], ['USD', 14.99], ['JPY', 2200], ['KWD', 4.999]]) {
      const formatted = formatPromotionMoney(amount, currency, locale);
      assert.equal(formatted, new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount));
      assert.doesNotMatch(formatted, /NaN|undefined/);
    }
  }
});

test('remote reads succeed, removed offers take effect, and failures never retain old config', async () => {
  let url, options;
  const result = await fetchPromotionConfig({ now: () => now, fetchImpl: async (u, o) => { url = u; options = o; return response(config); } });
  assert.deepEqual(result, { config, receivedAt: now });
  assert.match(url, /\/main\/config\/promotions\.json\?t=/);
  assert.equal(options.cache, 'no-store');
  assert.deepEqual((await fetchPromotionConfig({ fetchImpl: async () => response({ version: 1, lifetime: {} }) })).config.lifetime, {});
  for (const fetchImpl of [
    async () => { throw Error('offline'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, text: async () => '{ broken json' }),
    async () => response({ version: 999 }),
    async () => ({ ok: true, text: async () => 'x'.repeat(32769) }),
  ]) assert.equal(await fetchPromotionConfig({ fetchImpl }), null);
});

test('timeouts bound both connection and response-body hangs and abort the request', async () => {
  for (const bodyHang of [false, true]) {
    let signal;
    const result = await fetchPromotionConfig({ timeoutMs: 10, fetchImpl: async (_, options) => {
      signal = options.signal;
      if (!bodyHang) return new Promise(() => {});
      return { ok: true, text: () => new Promise(() => {}) };
    } });
    assert.equal(result, null);
    assert.equal(signal.aborted, true);
  }
});
