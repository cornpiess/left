import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { DAILY_FREE_LIMIT } from '../src/membershipCore.mjs';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('production config does not declare unused microphone access', async () => {
  const [pkg, app] = await Promise.all([
    readJson(new URL('../package.json', import.meta.url)),
    readJson(new URL('../app.json', import.meta.url)),
  ]);

  assert.equal(
    pkg.dependencies?.['expo-image-picker'],
    undefined,
    'Unused expo-image-picker injects placeholder camera and microphone purpose strings during EAS Build'
  );
  assert.equal(
    app.expo?.ios?.infoPlist?.NSMicrophoneUsageDescription,
    undefined,
    'The app does not record audio and must not declare microphone access'
  );
});

test('published legal documents stay synchronized and contain App Review disclosures', async () => {
  // The App Store description is private ASO material: public snapshots of this
  // repository intentionally omit docs/APP_STORE_DESCRIPTION_ZH_HANS.txt, so its
  // assertions only run where the file exists. The legal-pages sync assertions
  // below always run.
  const storeDescriptionUrl = new URL('../docs/APP_STORE_DESCRIPTION_ZH_HANS.txt', import.meta.url);
  const hasStoreDescription = await access(storeDescriptionUrl).then(
    () => true,
    () => false
  );
  const [terms, publicTerms, privacy, publicPrivacy, storeDescription] = await Promise.all([
    readFile(new URL('../terms.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/terms.html', import.meta.url), 'utf8'),
    readFile(new URL('../privacy.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/privacy.html', import.meta.url), 'utf8'),
    hasStoreDescription ? readFile(storeDescriptionUrl, 'utf8') : Promise.resolve(null),
  ]);

  assert.equal(publicTerms, terms, 'public/terms.html must match terms.html');
  assert.equal(publicPrivacy, privacy, 'public/privacy.html must match privacy.html');

  assert.match(terms, /https:\/\/www\.apple\.com\/legal\/internet-services\/itunes\/dev\/stdeula\//);
  assert.match(terms, /com\.cornpiess\.hairball\.yearly/);
  assert.match(terms, /com\.cornpiess\.hairball\.lifetime/);
  assert.match(terms, /28\.00/);
  assert.match(terms, /98\.00/);
  assert.doesNotMatch(terms, /99\.00/);
  assert.match(terms, /24\s*小时/);
  assert.match(terms, /恢复购买/);
  const quotaDisclosure = new RegExp(`每日(?:可处理|提供|可新选)\\s*${DAILY_FREE_LIMIT}\\s*张`);
  assert.match(terms, quotaDisclosure, 'Terms quota must match DAILY_FREE_LIMIT');

  for (const disclosure of ['不会收集', '相册', 'Apple', '保存期限', '删除', '撤回']) {
    assert.match(privacy, new RegExp(disclosure), `Privacy policy must disclose: ${disclosure}`);
  }

  if (hasStoreDescription) {
    assert.match(storeDescription, quotaDisclosure, 'App Store description quota must match DAILY_FREE_LIMIT');
    assert.match(storeDescription, /https:\/\/www\.apple\.com\/legal\/internet-services\/itunes\/dev\/stdeula\//);
    assert.match(storeDescription, /https:\/\/cornpiess\.github\.io\/delete_photo\/privacy\.html/);
  }
});

test('photo GPS metadata is never sent to third-party geocoding services', async () => {
  const mediaSource = await readFile(new URL('../src/media.js', import.meta.url), 'utf8');

  assert.doesNotMatch(mediaSource, /api\.bigdatacloud\.net/);
  assert.doesNotMatch(mediaSource, /nominatim\.openstreetmap\.org/);
});

test('production build hides unfinished and internal-only feed controls', async () => {
  const [app, home, menu] = await Promise.all([
    readJson(new URL('../app.json', import.meta.url)),
    readFile(new URL('../src/screens/HomeScreen.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/MoreMenuModal.js', import.meta.url), 'utf8'),
  ]);

  assert.match(app.expo.ios.buildNumber, /^\d+$/);
  assert.doesNotMatch(home, /versionTag|v262 \(B13\)/);
  assert.match(menu, /recommendStorage|recommendDefault/);
  assert.doesNotMatch(home, /quotaBaseUsedRef|recordCardViewed\(\)/,
    'Views must use the shared exposure policy rather than index-derived quota');
});

test('permission denial routes to system settings instead of a dead CTA', async () => {
  const screen = await readFile(new URL('../src/screens/PermissionScreen.js', import.meta.url), 'utf8');

  assert.match(screen, /Linking\.openSettings/, 'Denied state must deep-link into iOS Settings');
  assert.match(screen, /AppState\.addEventListener/, 'Returning from Settings must re-check the permission');
});

test('production config drops the unused photo-add permission', async () => {
  const app = await readJson(new URL('../app.json', import.meta.url));

  assert.equal(
    app.expo?.ios?.infoPlist?.NSPhotoLibraryAddUsageDescription,
    undefined,
    'The app never writes to the photo library and must not declare add access'
  );
  const mediaLibraryPlugin = (app.expo?.plugins || []).find(
    (p) => Array.isArray(p) && p[0] === 'expo-media-library'
  );
  assert.equal(
    mediaLibraryPlugin?.[1]?.savePhotosPermission,
    undefined,
    'expo-media-library savePhotosPermission must stay unset for the same reason'
  );
});

test('user-facing copy avoids third-party brands and dev-client references', async () => {
  const locales = ['zh-Hans', 'zh-Hant', 'en', 'es', 'ja', 'ko'];
  for (const locale of locales) {
    const src = await readFile(new URL(`../src/i18n/locales/${locale}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /TikTok|抖音/, `${locale} must not reference third-party brands`);
    assert.doesNotMatch(src, /Expo Go/, `${locale} must not surface dev-client references`);
  }
});

test('paywall discloses auto-renewal terms in every supported locale', async () => {
  const locales = ['zh-Hans', 'zh-Hant', 'en', 'es', 'ja', 'ko'];
  for (const locale of locales) {
    const src = await readFile(new URL(`../src/i18n/locales/${locale}.js`, import.meta.url), 'utf8');
    const match = src.match(/autoRenewDisclosure: ['"]([^'"]+)['"]/);
    assert.ok(match, `${locale} must define paywall.autoRenewDisclosure`);
    assert.match(match[1], /24/, `${locale} disclosure must state the 24-hour cancellation window`);
  }
  const paywall = await readFile(new URL('../src/components/PaywallModal.js', import.meta.url), 'utf8');
  assert.match(paywall, /paywall\.autoRenewDisclosure/, 'PaywallModal must render the disclosure');
  assert.doesNotMatch(paywall, /paywall\.upgradeNotice/, 'upgradeNotice is a dead key; use yearlyNotice');
});

test('hidden activation entry is silent and requires seven taps', async () => {
  const menu = await readFile(new URL('../src/components/MoreMenuModal.js', import.meta.url), 'utf8');

  assert.match(menu, />= 7/, 'Activation entry must require 7 taps');
  assert.doesNotMatch(menu, /再连按/, 'No progressive hint toast may reveal the hidden entry');
  assert.doesNotMatch(menu, /触发开发者测试模式/, 'No developer-mode toast may appear in production');
});

test('emptying the trash uses a sole system confirmation', async () => {
  const [gallery, media] = await Promise.all([
    readFile(new URL('../src/components/TrashGallery.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/media.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(gallery, /Alert\.alert/, 'PhotoKit supplies the sole confirmation');
  assert.match(gallery, /recentlyDeletedHint/, 'Explain the recovery destination before deletion');
  assert.match(media, /deleteAssetsWithSystemConfirmation\(ids, MediaLibrary\.deleteAssetsAsync\)/);
  assert.doesNotMatch(media, /const chunkSize = 50/);
});

test('contextual hints are localized and old tutorial completion is respected', async () => {
  const [home, hints] = await Promise.all([
    readFile(new URL('../src/screens/HomeScreen.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/useExperienceHints.js', import.meta.url), 'utf8'),
  ]);
  assert.match(home, /SwipeCoachOverlay/);
  assert.match(home, /learnHint\('select'\)/);
  assert.match(hints, /vibe-swipe-coach-done/);
});
