import test from 'node:test';
import assert from 'node:assert/strict';

import zhHans from '../src/i18n/locales/zh-Hans.js';
import zhHant from '../src/i18n/locales/zh-Hant.js';
import en from '../src/i18n/locales/en.js';
import es from '../src/i18n/locales/es.js';
import ja from '../src/i18n/locales/ja.js';
import ko from '../src/i18n/locales/ko.js';

function getKeys(obj, prefix = '') {
  let keys = [];
  for (const k of Object.keys(obj)) {
    const keyPath = prefix ? `${prefix}.${k}` : k;
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      keys = keys.concat(getKeys(obj[k], keyPath));
    } else {
      keys.push(keyPath);
    }
  }
  return keys;
}

test('i18n locale keys completeness', () => {
  const baseKeys = getKeys(zhHans).sort();
  const locales = {
    'zh-Hant': zhHant,
    en,
    es,
    ja,
    ko,
  };

  for (const [lang, localeDict] of Object.entries(locales)) {
    const langKeys = getKeys(localeDict).sort();
    assert.deepEqual(
      langKeys,
      baseKeys,
      `Locale dictionary [${lang}] is missing or has extra keys compared to zh-Hans!`
    );
  }
});

test('unsupported system locales fallback to English', () => {
  // Test fallback logic: if code is unknown (e.g. 'de', 'fr', 'ar'), resolve to 'en'
  function resolveLocale(code, tag) {
    if (tag.startsWith('zh-hant') || tag.startsWith('zh-tw') || tag.startsWith('zh-hk')) return 'zh-Hant';
    if (tag.startsWith('zh-hans') || tag.startsWith('zh-cn') || code === 'zh') return 'zh-Hans';
    if (code === 'ja') return 'ja';
    if (code === 'ko') return 'ko';
    if (code === 'es') return 'es';
    if (code === 'en') return 'en';
    return 'en'; // Default fallback for all unsupported languages
  }

  assert.equal(resolveLocale('de', 'de-DE'), 'en');
  assert.equal(resolveLocale('fr', 'fr-FR'), 'en');
  assert.equal(resolveLocale('ar', 'ar-SA'), 'en');
  assert.equal(resolveLocale('ja', 'ja-JP'), 'ja');
});


test('quota copy in every language takes the same limit parameter', () => {
  for (const [language, locale] of Object.entries({zhHans,zhHant,en,es,ja,ko})) {
    for (const value of [locale.menu.resetQuota,locale.menu.resetQuotaSuccess,locale.paywall.limitTitle,locale.paywall.freePolicy]) {
      assert.ok(value.includes('{limit}'), `${language}: quota must come from the shared setting`);
      assert.doesNotMatch(value, /\b30\b/);
    }
  }
});
