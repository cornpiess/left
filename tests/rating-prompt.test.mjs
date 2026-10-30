import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  APP_STORE_ID,
  APP_STORE_WRITE_REVIEW_URL,
  APP_STORE_WRITE_REVIEW_WEB_URL,
  RATING_LATER_COOLDOWN_MS,
  RATING_MIN_CLEANED_BYTES,
  buildRatingPromptStateAfterAction,
  shouldOfferRatingPrompt,
} from '../src/ratingPrompt.mjs';

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

test('rating prompt stays hidden below the cleaned-space milestone', () => {
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 0, promptState: null }), false);
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: RATING_MIN_CLEANED_BYTES - 1, promptState: null }), false);
});

test('rating prompt appears at the milestone and never interrupts earlier', () => {
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: RATING_MIN_CLEANED_BYTES, promptState: null }), true);
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 5 * 1024 * MB, promptState: null }), true);
});

test('a completed rating silences the automatic prompt forever', () => {
  const state = buildRatingPromptStateAfterAction(null, 'rated', 1000);
  assert.deepEqual(state, { lastAction: 'rated', lastActionAt: 1000 });
  // Even far beyond any cooldown, and even with a huge cleaned total.
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 10 * 1024 * MB, promptState: state, now: 1000 + 400 * DAY_MS }), false);
});

test('"later" starts a cooldown, then the prompt may return once', () => {
  const state = buildRatingPromptStateAfterAction(null, 'later', 1000);
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 500 * MB, promptState: state, now: 1000 + RATING_LATER_COOLDOWN_MS - 1 }), false);
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 500 * MB, promptState: state, now: 1000 + RATING_LATER_COOLDOWN_MS }), true);
});

test('unknown or corrupt prompt state degrades to showing the prompt', () => {
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 500 * MB, promptState: undefined }), true);
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 500 * MB, promptState: {} }), true);
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 500 * MB, promptState: { lastAction: 'later' } }), true);
  assert.equal(shouldOfferRatingPrompt({ cleanedBytes: 500 * MB, promptState: { lastAction: 'nonsense' } }), true);
});

test('buildRatingPromptStateAfterAction ignores invalid actions', () => {
  const prev = { lastAction: 'later', lastActionAt: 5 };
  assert.equal(buildRatingPromptStateAfterAction(prev, 'double-click'), prev);
  assert.equal(buildRatingPromptStateAfterAction(null, undefined), null);
});

test('review URLs point at the shipped App Store id with an https fallback', () => {
  assert.equal(APP_STORE_ID, '6804368763');
  assert.match(APP_STORE_WRITE_REVIEW_URL, /^itms-apps:\/\//);
  assert.match(APP_STORE_WRITE_REVIEW_URL, /action=write-review/);
  assert.match(APP_STORE_WRITE_REVIEW_WEB_URL, /^https:\/\/apps\.apple\.com\//);
  assert.match(APP_STORE_WRITE_REVIEW_WEB_URL, /action=write-review/);
});

test('the completion page hosts the rating card and the menu keeps a permanent entry', async () => {
  const [home, moreMenu, ratingStore] = await Promise.all([
    readFile(new URL('../src/screens/HomeScreen.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/MoreMenuModal.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ratingStore.js', import.meta.url), 'utf8'),
  ]);

  // Completion-page card only — inside the kind === 'complete' branch.
  const completeBranch = home.split("item.kind === 'complete'")[1];
  assert.ok(completeBranch, 'completion branch missing');
  assert.match(completeBranch, /shouldOfferRatingPrompt\(/);
  assert.match(completeBranch, /getTotalCleanedBytes\(\)/);
  assert.match(completeBranch, /handleRateApp/);
  assert.match(completeBranch, /handleRateLater/);
  assert.match(completeBranch, /t\('rating\.cardTitle'\)/);
  assert.match(completeBranch, /t\('rating\.rateBtn'\)/);
  assert.match(completeBranch, /t\('rating\.laterBtn'\)/);

  // Rated marks state only after a successful open; later always marks.
  assert.match(home, /buildRatingPromptStateAfterAction\(prev, 'rated'\)/);
  assert.match(home, /buildRatingPromptStateAfterAction\(prev, 'later'\)/);

  // Permanent, user-initiated menu entry.
  assert.match(moreMenu, /t\('menu\.rateApp'\)/);
  assert.match(moreMenu, /openAppStoreReview\(\)/);
  assert.match(moreMenu, /t\('rating\.toastFailed'\)/);

  // Store wrapper routes through itms-apps first, https fallback second.
  assert.match(ratingStore, /\[APP_STORE_WRITE_REVIEW_URL, APP_STORE_WRITE_REVIEW_WEB_URL\]/);
  assert.match(ratingStore, /Linking\.openURL\(url\)/);
  assert.match(ratingStore, /AsyncStorage\.setItem\(RATING_PROMPT_STORAGE_KEY/);
});

test('all six locales expose the rating strings', async () => {
  const files = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'es'];
  for (const lang of files) {
    const src = await readFile(new URL(`../src/i18n/locales/${lang}.js`, import.meta.url), 'utf8');
    for (const key of ['rateApp', 'cardTitle', 'cardBody', 'rateBtn', 'laterBtn', 'toastFailed']) {
      assert.match(src, new RegExp(`\\b${key}:`), `${lang} missing rating key ${key}`);
    }
  }
});
