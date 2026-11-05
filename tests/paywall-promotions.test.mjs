import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent, flatten } from './support/render-component.mjs';
import * as membershipCore from '../src/membershipCore.mjs';
import en from '../src/i18n/locales/en.js';
import es from '../src/i18n/locales/es.js';
import ja from '../src/i18n/locales/ja.js';
import ko from '../src/i18n/locales/ko.js';
import zhHans from '../src/i18n/locales/zh-Hans.js';
import zhHant from '../src/i18n/locales/zh-Hant.js';
import { formatPromotionMoney } from '../src/promotions.mjs';

const locales = { en, es, ja, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant };
const text = tree => flatten(tree).flatMap(node => node.children.filter(value => typeof value === 'string')).join('\n');
function setup({ language = 'en', member = {}, context = {}, status = 'ready', products, effects = false, clock } = {}) {
  const dict = locales[language];
  const t = (key, values = {}) => {
    let value = key.split('.').reduce((obj, key) => obj?.[key], dict) ?? key;
    for (const [name, replacement] of Object.entries(values)) value = value.replaceAll(`{${name}}`, replacement);
    return value;
  };
  const catalog = { status, products: products ?? {
    [membershipCore.IAP_SKUS.YEARLY]: { displayPrice: '¥28.00', price: 28, currency: 'CNY' },
    [membershipCore.IAP_SKUS.LIFETIME]: { displayPrice: '¥78.00', price: 78, currency: 'CNY' },
  }, promotionContext: { config: { version: 1, lifetime: { CHN: { currency: 'CNY', regularPrice: 98, salePrice: 78 } } }, storefront: 'CHN', receivedAt: Date.now(), ...context } };
  const props = { visible: true, reason: 'quota' };
  const component = renderComponent('components/PaywallModal.js', props, {
    '../membershipCore.mjs': membershipCore,
    '../membership': { getIapCatalogState: () => catalog, getMembershipState: () => member, subscribeIapProducts: () => () => {}, IAP_SKUS: membershipCore.IAP_SKUS, DAILY_FREE_LIMIT: membershipCore.DAILY_FREE_LIMIT },
    '../i18n': { useI18n: () => ({ t, currentLocale: language }) },
  }, { effects, clock });
  return { component, props, catalog, t, dict };
}

for (const language of Object.keys(locales)) {
  test(`${language}: the free and upgrade paywalls share actual price, original price and translated savings`, () => {
    for (const member of [{ isPro: false }, { isPro: true, planType: 'yearly' }]) {
      const { component, t, dict } = setup({ language, member });
      const tree = component.render(), output = text(tree);
      assert.ok(output.includes('¥78.00'), 'Apple displayPrice is preserved verbatim');
      assert.ok(output.includes(formatPromotionMoney(98, 'CNY', language)));
      assert.ok(output.includes(t('paywall.saleSavings', { amount: formatPromotionMoney(20, 'CNY', language) })));
      assert.equal(output.split(dict.paywall.saleLimited).length - 1, 1);
      assert.doesNotMatch(output, /paywall\.|\{(?:price|amount)\}|NaN|undefined/);
      // Long translated badges and labels must wrap instead of being clipped.
      for (const node of flatten(tree).filter(node => node.children.some(child => [dict.paywall.planLifetime, dict.paywall.planUpgrade, dict.paywall.saleLimited].includes(child)))) {
        assert.equal(node.props.numberOfLines, undefined);
      }
      component.unmount();
    }
  });
}

test('wrong storefront, stale metadata and catalog errors hide all discount decoration', () => {
  for (const options of [
    { context: { storefront: 'USA' } }, { context: { receivedAt: 0 } },
    { status: 'loading' }, { status: 'error' },
    { context: { config: { version: 1, lifetime: {} } } },
  ]) {
    const { component, dict } = setup(options);
    const output = text(component.render());
    assert.ok(output.includes('¥78.00'));
    assert.ok(!output.includes(dict.paywall.saleLimited));
    assert.ok(!output.includes('$98.00') && !output.includes('CN¥98.00'));
    component.unmount();
  }
});

test('unknown prices show a translated placeholder and disabled actions in every language', () => {
  for (const language of Object.keys(locales)) {
    const { component, dict } = setup({ language, products: {}, status: 'idle' });
    const tree = component.render(), output = text(tree);
    assert.ok(output.includes(dict.paywall.pricePending));
    assert.doesNotMatch(output, /¥|98|78/);
    const planButtons = flatten(tree).filter(node => node.props.containerStyle?.width === '100%');
    assert.equal(planButtons.length, 2);
    assert.ok(planButtons.every(node => node.props.disabled));
    component.unmount();
  }
});

test('an offer expires while the paywall remains open and closing cancels the timer', () => {
  let now = Date.now(), callback, delay, cancelled = false;
  const receivedAt = now;
  const clock = { Date: class extends Date { static now() { return now; } }, setTimeout: (fn, ms) => { callback = fn; delay = ms; return 1; }, clearTimeout: () => { cancelled = true; } };
  const endsAt = new Date(now + 60000).toISOString();
  const { component, dict } = setup({ effects: true, clock, context: { receivedAt, config: { version: 1, lifetime: { CHN: { currency: 'CNY', regularPrice: 98, salePrice: 78, endsAt } } } } });
  assert.ok(text(component.render()).includes(dict.paywall.saleLimited));
  component.flushEffects();
  assert.equal(delay, 60001);
  now += 60001;
  callback();
  assert.ok(!text(component.render()).includes(dict.paywall.saleLimited));
  component.flushEffects();
  component.unmount();
  assert.ok(cancelled);
});
